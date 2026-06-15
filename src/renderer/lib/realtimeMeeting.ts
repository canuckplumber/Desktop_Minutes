import { meetingApi } from "../api";
import type {
  AppConfig,
  CaptureDiagnostics,
  CaptureState,
  DelayOption,
  SessionStatus,
  TranscriptSegment,
} from "../types";

interface ClientCallbacks {
  onDiagnosticsChange: (diagnostics: CaptureDiagnostics) => void;
  onStatusChange: (status: SessionStatus, errorMessage?: string) => void;
  onTranscriptPatch: (patch: TranscriptSegment) => void;
}

interface StartOptions {
  delay: DelayOption;
  deviceId?: string;
  language: string;
}

const LEVEL_CHECK_INTERVAL_MS = 120;
const MAX_TURN_DURATION_MS = 12000;
const MIN_COMMIT_GAP_MS = 1800;
const SILENCE_COMMIT_DELAY_MS = 1000;
const SPEECH_RMS_THRESHOLD = 0.018;

export class RealtimeMeetingClient {
  #analyser: AnalyserNode | null = null;
  #audioContext: AudioContext | null = null;
  #callbacks: ClientCallbacks;
  #commitTimer: number | null = null;
  #config: AppConfig;
  #dataChannel: RTCDataChannel | null = null;
  #diagnostics: CaptureDiagnostics = createDefaultDiagnostics();
  #lastCommitAt = 0;
  #lastHeardAt = 0;
  #levelBuffer: Uint8Array | null = null;
  #mediaStream: MediaStream | null = null;
  #peerConnection: RTCPeerConnection | null = null;
  #speechActive = false;
  #stopping = false;
  #turnStartedAt = 0;

  constructor(config: AppConfig, callbacks: ClientCallbacks) {
    this.#config = config;
    this.#callbacks = callbacks;
  }

  async start(options: StartOptions) {
    this.#stopping = false;
    this.#diagnostics = createDefaultDiagnostics();
    this.#emitDiagnostics();
    this.#callbacks.onStatusChange("connecting");

    try {
      const token = await meetingApi.createRealtimeToken({
        language: options.language,
        delay: options.delay,
      });

      if (!token.value) {
        throw new Error("The realtime token response did not include a client secret.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          channelCount: 1,
          deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      this.#mediaStream = stream;
      this.#diagnostics.inputDeviceLabel = stream.getAudioTracks()[0]?.label || "Microphone";
      this.#setCaptureState("listening");
      this.#emitDiagnostics();

      await this.#setupAudioMonitor(stream);

      this.#peerConnection = new RTCPeerConnection();
      this.#dataChannel = this.#peerConnection.createDataChannel("oai-events");

      this.#peerConnection.addEventListener("connectionstatechange", () => {
        const state = this.#peerConnection?.connectionState;
        if (state === "connected") {
          this.#callbacks.onStatusChange("live");
        }

        if (!this.#stopping && (state === "failed" || state === "disconnected")) {
          this.#callbacks.onStatusChange(
            "error",
            "The live transcription connection dropped.",
          );
        }
      });

      this.#dataChannel.addEventListener("open", () => {
        this.#sendEvent({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                transcription: {
                  delay: options.delay,
                  language: options.language,
                  model: this.#config.realtimeTranscriptionModel,
                },
                turn_detection: null,
              },
            },
          },
        });

        this.#scheduleCommitLoop();
      });

      this.#dataChannel.addEventListener("message", (event) => {
        this.#handleRealtimeMessage(event);
      });

      stream.getTracks().forEach((track) => {
        this.#peerConnection?.addTrack(track, stream);
      });

      const offer = await this.#peerConnection.createOffer();
      await this.#peerConnection.setLocalDescription(offer);

      const response = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!response.ok) {
        const details = await response.text();
        throw new Error(details || "Failed to create the realtime session.");
      }

      const answer = {
        type: "answer" as RTCSdpType,
        sdp: await response.text(),
      };

      await this.#peerConnection.setRemoteDescription(answer);
    } catch (error) {
      await this.stop();
      this.#callbacks.onStatusChange(
        "error",
        error instanceof Error ? error.message : "Unable to start live transcription.",
      );
      throw error;
    }
  }

  async stop() {
    this.#stopping = true;
    this.#callbacks.onStatusChange("stopping");

    this.#clearCommitLoop();

    try {
      this.#commitBuffer();
      await delay(900);
    } catch {
      // Ignore commit errors while shutting down.
    }

    this.#dataChannel?.close();
    this.#peerConnection?.close();
    this.#mediaStream?.getTracks().forEach((track) => track.stop());

    await this.#audioContext?.close().catch(() => undefined);

    this.#analyser = null;
    this.#audioContext = null;
    this.#dataChannel = null;
    this.#levelBuffer = null;
    this.#mediaStream = null;
    this.#peerConnection = null;
    this.#lastCommitAt = 0;
    this.#lastHeardAt = 0;
    this.#speechActive = false;
    this.#turnStartedAt = 0;
    this.#diagnostics.audioLevel = 0;
    this.#setCaptureState("idle");
    this.#emitDiagnostics();
    this.#callbacks.onStatusChange("idle");
  }

  async #setupAudioMonitor(stream: MediaStream) {
    this.#audioContext = new AudioContext();
    const source = this.#audioContext.createMediaStreamSource(stream);
    this.#analyser = this.#audioContext.createAnalyser();
    this.#analyser.fftSize = 2048;
    this.#analyser.smoothingTimeConstant = 0.25;
    source.connect(this.#analyser);
    this.#levelBuffer = new Uint8Array(this.#analyser.fftSize);
  }

  #handleRealtimeMessage(event: MessageEvent<string>) {
    const payload = JSON.parse(event.data);

    if (payload.type === "conversation.item.input_audio_transcription.delta") {
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if (!delta) {
        return;
      }

      this.#callbacks.onTranscriptPatch({
        id: payload.item_id,
        text: delta,
        status: "partial",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    if (payload.type === "conversation.item.input_audio_transcription.completed") {
      const transcript =
        typeof payload.transcript === "string" ? payload.transcript.trim() : "";

      if (transcript) {
        this.#diagnostics.lastTranscriptAt = new Date().toISOString();
      } else {
        this.#diagnostics.emptyTurns += 1;
      }

      this.#setCaptureState("listening");
      this.#emitDiagnostics();

      this.#callbacks.onTranscriptPatch({
        id: payload.item_id,
        text: transcript,
        status: "final",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    if (payload.type === "error") {
      this.#callbacks.onStatusChange(
        "error",
        payload.error?.message || "OpenAI returned a realtime error.",
      );
    }
  }

  #scheduleCommitLoop() {
    this.#clearCommitLoop();
    this.#commitTimer = window.setInterval(() => {
      this.#monitorAudioLevel();
    }, LEVEL_CHECK_INTERVAL_MS);
  }

  #monitorAudioLevel() {
    if (!this.#analyser || !this.#levelBuffer) {
      return;
    }

    this.#analyser.getByteTimeDomainData(this.#levelBuffer);

    let sumSquares = 0;
    for (let index = 0; index < this.#levelBuffer.length; index += 1) {
      const sample = (this.#levelBuffer[index] - 128) / 128;
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / this.#levelBuffer.length);
    const uiLevel = Math.min(1, rms * 16);
    const now = Date.now();

    this.#diagnostics.audioLevel = uiLevel;

    if (rms >= SPEECH_RMS_THRESHOLD) {
      this.#lastHeardAt = now;
      this.#diagnostics.lastHeardAt = new Date().toISOString();

      if (!this.#speechActive) {
        this.#speechActive = true;
        this.#turnStartedAt = now;
      }

      this.#setCaptureState("hearing-speech");
      this.#emitDiagnostics();
      return;
    }

    if (!this.#speechActive) {
      this.#setCaptureState("listening");
      this.#emitDiagnostics();
      return;
    }

    if (now - this.#turnStartedAt >= MAX_TURN_DURATION_MS) {
      this.#commitBuffer();
      return;
    }

    if (now - this.#lastHeardAt >= SILENCE_COMMIT_DELAY_MS) {
      this.#commitBuffer();
      return;
    }

    this.#setCaptureState("processing-turn");
    this.#emitDiagnostics();
  }

  #commitBuffer() {
    if (Date.now() - this.#lastCommitAt < MIN_COMMIT_GAP_MS) {
      return;
    }

    if (this.#dataChannel?.readyState !== "open") {
      return;
    }

    this.#dataChannel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.#lastCommitAt = Date.now();
    this.#diagnostics.committedTurns += 1;
    this.#speechActive = false;
    this.#turnStartedAt = 0;
    this.#setCaptureState("processing-turn");
    this.#emitDiagnostics();
  }

  #clearCommitLoop() {
    if (this.#commitTimer !== null) {
      window.clearInterval(this.#commitTimer);
      this.#commitTimer = null;
    }
  }

  #emitDiagnostics() {
    this.#callbacks.onDiagnosticsChange({ ...this.#diagnostics });
  }

  #sendEvent(payload: unknown) {
    if (this.#dataChannel?.readyState === "open") {
      this.#dataChannel.send(JSON.stringify(payload));
    }
  }

  #setCaptureState(state: CaptureState) {
    this.#diagnostics.state = state;
  }
}

function createDefaultDiagnostics(): CaptureDiagnostics {
  return {
    audioLevel: 0,
    committedTurns: 0,
    emptyTurns: 0,
    inputDeviceLabel: "System default microphone",
    lastHeardAt: null,
    lastTranscriptAt: null,
    state: "idle",
  };
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
