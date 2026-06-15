import { useEffect, useRef, useState } from "react";
import { meetingApi } from "./api";
import appIcon from "./assets/meeting-minutes-icon.svg";
import {
  defaultAudioInputs,
  detectBestAudioInput,
  enumerateAudioInputDevices,
} from "./lib/audioInputDetection";
import { RealtimeMeetingClient } from "./lib/realtimeMeeting";
import type {
  AnalysisResult,
  AppConfig,
  AudioInputDetectionResult,
  AudioInputDevice,
  CaptureDiagnostics,
  CaptureState,
  DelayOption,
  MeetingAnalysisPayload,
  SessionStatus,
  TranscriptSegment,
} from "./types";

const delayOptions: DelayOption[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export default function App() {
  const [audioInputs, setAudioInputs] = useState<AudioInputDevice[]>(defaultAudioInputs);
  const [detectingInput, setDetectingInput] = useState(false);
  const [detectionResult, setDetectionResult] =
    useState<AudioInputDetectionResult | null>(null);
  const [detectionStatus, setDetectionStatus] = useState(
    "Use Detect best mic, then speak for a few seconds near the microphone you want to use.",
  );
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [captureDiagnostics, setCaptureDiagnostics] = useState<CaptureDiagnostics>(
    createDefaultDiagnostics(),
  );
  const [meetingTitle, setMeetingTitle] = useState("Weekly leadership sync");
  const [participants, setParticipants] = useState("Alex, Morgan, Priya");
  const [manualNotes, setManualNotes] = useState("");
  const [minutesDraft, setMinutesDraft] = useState("");
  const [language, setLanguage] = useState("en");
  const [delay, setDelay] = useState<DelayOption>("low");
  const [selectedInputId, setSelectedInputId] = useState("");
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>(
    [],
  );
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [lastSavedPath, setLastSavedPath] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const clientRef = useRef<RealtimeMeetingClient | null>(null);
  const transcriptRef = useRef<TranscriptSegment[]>([]);
  const manualNotesRef = useRef("");
  const minutesDraftRef = useRef("");
  const titleRef = useRef(meetingTitle);
  const participantsRef = useRef(participants);
  const analysisBusyRef = useRef(false);
  const lastAnalyzedFinalCountRef = useRef(0);
  const runAnalysisRef = useRef<(force?: boolean) => Promise<void>>(
    async () => {},
  );

  useEffect(() => {
    void meetingApi.getConfig().then((loadedConfig) => {
      setConfig(loadedConfig);
      setLanguage(loadedConfig.defaultLanguage);
      setDelay(loadedConfig.transcriptionDelay);
    });
  }, []);

  useEffect(() => {
    const loadAudioInputs = async () => {
      const devices = await enumerateAudioInputDevices();
      setAudioInputs(devices);
      if (
        selectedInputId &&
        !devices.some((device) => device.deviceId === selectedInputId)
      ) {
        setSelectedInputId("");
      }
    };

    void loadAudioInputs();

    const mediaDevices = navigator.mediaDevices;
    const onDeviceChange = () => {
      void loadAudioInputs();
    };

    mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, [selectedInputId]);

  useEffect(() => {
    transcriptRef.current = transcriptSegments;
  }, [transcriptSegments]);

  useEffect(() => {
    manualNotesRef.current = manualNotes;
  }, [manualNotes]);

  useEffect(() => {
    minutesDraftRef.current = minutesDraft;
  }, [minutesDraft]);

  useEffect(() => {
    titleRef.current = meetingTitle;
  }, [meetingTitle]);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  useEffect(() => {
    analysisBusyRef.current = analysisBusy;
  }, [analysisBusy]);

  useEffect(() => {
    if (!startedAt || (status !== "live" && status !== "connecting")) {
      return;
    }

    const timer = window.setInterval(() => {
      const started = new Date(startedAt).getTime();
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [startedAt, status]);

  async function startMeeting() {
    if (!config) {
      return;
    }

    setErrorMessage("");
    setLastSavedPath("");
    setStartedAt(new Date().toISOString());
    setElapsedSeconds(0);
    setTranscriptSegments([]);
    setAnalysis(null);
    setMinutesDraft("");
    setCaptureDiagnostics(createDefaultDiagnostics());
    setDetectionStatus("Meeting is live. Device detection is paused while recording.");
    lastAnalyzedFinalCountRef.current = 0;

    const client = new RealtimeMeetingClient(config, {
      onDiagnosticsChange: (diagnostics) => {
        setCaptureDiagnostics(diagnostics);
      },
      onStatusChange: (nextStatus, message) => {
        setStatus(nextStatus);
        if (message) {
          setErrorMessage(message);
        }
      },
      onTranscriptPatch: (patch) => {
        setTranscriptSegments((current) => mergeTranscriptSegment(current, patch));
      },
    });

    clientRef.current = client;
    await client.start({
      delay,
      deviceId: selectedInputId || undefined,
      language,
    });

    void enumerateAudioInputDevices().then((devices) => {
      setAudioInputs(devices);
    });
  }

  async function stopMeeting() {
    setErrorMessage("");

    try {
      await clientRef.current?.stop();
      clientRef.current = null;
      await runAnalysisRef.current(true);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to stop the session cleanly.",
      );
    }
  }

  runAnalysisRef.current = async (force = false) => {
    if (!config || analysisBusyRef.current) {
      return;
    }

    const finalCount = transcriptRef.current.filter(
      (segment) => segment.status === "final" && segment.text.trim(),
    ).length;

    if (!force && finalCount === 0) {
      return;
    }

    if (!force && finalCount === lastAnalyzedFinalCountRef.current) {
      return;
    }

    setAnalysisBusy(true);
    setErrorMessage("");

    try {
      const payload: MeetingAnalysisPayload = {
        title: titleRef.current.trim() || "Untitled meeting",
        participants: participantsRef.current
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        manualNotes: manualNotesRef.current,
        minutesDraft: minutesDraftRef.current,
        transcriptSegments: transcriptRef.current,
      };

      const result = await meetingApi.analyzeMeeting(payload);
      lastAnalyzedFinalCountRef.current = finalCount;
      setAnalysis(result);
      setMinutesDraft(result.minutesDraft);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "The live meeting analysis request failed.",
      );
    } finally {
      setAnalysisBusy(false);
    }
  };

  useEffect(() => {
    if (!config || status !== "live") {
      return;
    }

    const timer = window.setInterval(() => {
      void runAnalysisRef.current(false);
    }, config.analysisIntervalMs);

    return () => window.clearInterval(timer);
  }, [config, status]);

  async function exportMinutes() {
    const result = await meetingApi.exportMinutes({
      title: meetingTitle,
      participants: participants
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      manualNotes,
      minutesDraft,
      transcriptSegments,
      analysis,
    });

    if (!result.canceled && result.filePath) {
      setLastSavedPath(result.filePath);
    }
  }

  async function detectBestMicrophone() {
    if (status === "connecting" || status === "live") {
      return;
    }

    setErrorMessage("");
    setDetectingInput(true);
    setDetectionResult(null);
    setDetectionStatus("Speak for a few seconds while the app samples your available microphones.");

    try {
      const devices = await enumerateAudioInputDevices();
      setAudioInputs(devices);

      const result = await detectBestAudioInput(devices);
      setDetectionResult(result);

      if (result.recommendedDeviceId) {
        setSelectedInputId(result.recommendedDeviceId);
      }

      setDetectionStatus(
        result.sufficientSignal
          ? `Recommended microphone: ${result.recommendedLabel}`
          : "No strong microphone signal stood out. A recommendation is still selected, but you may want to test manually.",
      );
    } catch (error) {
      setDetectionStatus("Microphone detection could not finish.");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to detect the best microphone for this session.",
      );
    } finally {
      setDetectingInput(false);
    }
  }

  const finalTranscript = transcriptSegments.filter(
    (segment) => segment.status === "final" && segment.text.trim(),
  );

  const transcriptWordCount = finalTranscript
    .map((segment) => segment.text)
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  const liveSummaryMessage = getLiveSummaryMessage(
    status,
    finalTranscript.length,
    captureDiagnostics,
  );

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <header className="hero-bar">
        <div className="hero-brand">
          <div className="hero-icon-shell">
            <img
              className="hero-icon"
              src={appIcon}
              alt="Meeting Minutes Studio icon"
            />
          </div>

          <div>
          <p className="eyebrow">Meeting Minutes Studio</p>
          <h1>Capture the room. Steer the conversation.</h1>
          <p className="hero-copy">
            Live transcript on the left, living minutes in the middle, and useful
            next points on the right.
          </p>
          </div>
        </div>

        <div className="hero-meta">
          <div className={`status-pill status-${status}`}>
            <span className="status-dot" />
            <span>{statusLabel(status)}</span>
          </div>
          <div className="metric-card">
            <span>Elapsed</span>
            <strong>{formatDuration(elapsedSeconds)}</strong>
          </div>
          <div className="metric-card">
            <span>Final transcript</span>
            <strong>{finalTranscript.length} turns</strong>
          </div>
          <div className="metric-card">
            <span>Words captured</span>
            <strong>{transcriptWordCount}</strong>
          </div>
        </div>
      </header>

      {!config?.hasApiKey ? (
        <section className="banner warning-banner">
          <strong>OpenAI key needed.</strong>
          <span>
            Set `OPENAI_API_KEY` in your Windows environment variables, then
            restart the app. A project `.env` file is only used as a fallback.
          </span>
        </section>
      ) : null}

      {errorMessage ? (
        <section className="banner error-banner">
          <strong>Something needs attention.</strong>
          <span>{errorMessage}</span>
        </section>
      ) : null}

      {!errorMessage &&
      status === "live" &&
      captureDiagnostics.emptyTurns > 1 &&
      finalTranscript.length === 0 ? (
        <section className="banner warning-banner">
          <strong>No usable speech yet.</strong>
          <span>
            The app is connected, but the selected microphone has not produced a
            usable transcript yet. Check the microphone picker and watch the level
            meter while you speak.
          </span>
        </section>
      ) : null}

      {lastSavedPath ? (
        <section className="banner success-banner">
          <strong>PDF exported.</strong>
          <span>{lastSavedPath}</span>
        </section>
      ) : null}

      <section className="controls-panel card">
        <div className="control-grid">
          <label className="field">
            <span>Meeting title</span>
            <input
              value={meetingTitle}
              onChange={(event) => setMeetingTitle(event.target.value)}
              placeholder="Q3 planning review"
            />
          </label>

          <label className="field">
            <span>Participants</span>
            <input
              value={participants}
              onChange={(event) => setParticipants(event.target.value)}
              placeholder="Comma-separated names"
            />
          </label>

          <label className="field">
            <span>Language</span>
            <input
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              placeholder="en"
            />
          </label>

          <label className="field">
            <span>Transcript latency</span>
            <select
              value={delay}
              onChange={(event) => setDelay(event.target.value as DelayOption)}
            >
              {delayOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Microphone</span>
            <select
              value={selectedInputId}
              disabled={status === "connecting" || status === "live"}
              onChange={(event) => setSelectedInputId(event.target.value)}
            >
              {audioInputs.map((device) => (
                <option
                  key={device.deviceId || "system-default"}
                  value={device.deviceId}
                >
                  {device.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="actions-row">
          <button
            className="primary-button"
            disabled={!config?.hasApiKey || status === "connecting" || status === "live"}
            onClick={() => void startMeeting()}
          >
            Start live meeting
          </button>
          <button
            className="secondary-button"
            disabled={status !== "live"}
            onClick={() => void stopMeeting()}
          >
            Stop and finalize
          </button>
          <button
            className="ghost-button"
            disabled={!config?.hasApiKey || analysisBusy}
            onClick={() => void runAnalysisRef.current(true)}
          >
            {analysisBusy ? "Refreshing..." : "Refresh suggestions"}
          </button>
          <button
            className="ghost-button"
            disabled={detectingInput || status === "connecting" || status === "live"}
            onClick={() => void detectBestMicrophone()}
          >
            {detectingInput ? "Detecting mic..." : "Detect best mic"}
          </button>
          <button
            className="ghost-button"
            disabled={!minutesDraft && !analysis}
            onClick={() => void exportMinutes()}
          >
            Export PDF
          </button>
        </div>

        <div className="capture-strip">
          <article className="capture-card">
            <span>Active microphone</span>
            <strong>{captureDiagnostics.inputDeviceLabel}</strong>
            <small>
              {selectedInputId ? "Specific input selected" : "Using system default"}
            </small>
          </article>

          <article className="capture-card">
            <span>Mic signal</span>
            <div className="level-meter" aria-hidden="true">
              <div
                className={`level-fill level-${captureDiagnostics.state}`}
                style={{
                  width:
                    status === "live"
                      ? `${Math.max(6, captureDiagnostics.audioLevel * 100)}%`
                      : "0%",
                }}
              />
            </div>
            <small>{micLevelLabel(captureDiagnostics.audioLevel, status)}</small>
          </article>

          <article className="capture-card">
            <span>Listening state</span>
            <strong>{captureStateLabel(captureDiagnostics.state)}</strong>
            <small>{captureStateHint(captureDiagnostics.state)}</small>
          </article>

          <article className="capture-card">
            <span>Transcript health</span>
            <strong>
              {finalTranscript.length} usable / {captureDiagnostics.emptyTurns} empty
            </strong>
            <small>
              {captureDiagnostics.lastTranscriptAt
                ? `Last usable turn at ${formatTime(captureDiagnostics.lastTranscriptAt)}`
                : "No usable turn captured yet"}
            </small>
          </article>
        </div>

        <div className="detection-strip">
          <article className="capture-card detection-card">
            <span>Device detection</span>
            <strong>
              {detectingInput
                ? "Listening across microphones..."
                : detectionResult?.recommendedLabel || "Not run yet"}
            </strong>
            <small>{detectionStatus}</small>
            {detectionResult?.samples.length ? (
              <div className="detection-list">
                {detectionResult.samples.slice(0, 3).map((sample) => (
                  <div
                    key={sample.deviceId}
                    className={`detection-item${
                      sample.deviceId === detectionResult.recommendedDeviceId
                        ? " detection-item-active"
                        : ""
                    }`}
                  >
                    <span>{sample.label}</span>
                    <strong>{describeDetectionStrength(sample.score)}</strong>
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        </div>
      </section>

      <main className="workspace">
        <section className="card panel transcript-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Live Transcript</p>
              <h2>What the room is saying</h2>
            </div>
            <span className="panel-note">
              Commits after short pauses so silence does not become fake turns.
            </span>
          </div>

          <div className="transcript-list">
            {transcriptSegments.length === 0 ? (
              <div className="empty-state">
                {status === "live"
                  ? "The app is listening. Speak near the selected microphone and watch the mic signal card above."
                  : "Start the meeting and the transcript will begin filling in here."}
              </div>
            ) : (
              transcriptSegments.map((segment) => (
                <article
                  key={segment.id}
                  className={`transcript-item transcript-${segment.status}`}
                >
                  <div className="transcript-topline">
                    <span>{segment.status === "final" ? "Final turn" : "Live draft"}</span>
                    <span>{formatTime(segment.updatedAt)}</span>
                  </div>
                  <p>{segment.text}</p>
                </article>
              ))
            )}
          </div>

          <label className="field notes-field">
            <span>Manual notes</span>
            <textarea
              value={manualNotes}
              onChange={(event) => setManualNotes(event.target.value)}
              placeholder="Add things the microphone might miss: body language, whiteboard notes, context, names..."
            />
          </label>
        </section>

        <section className="card panel minutes-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Living Minutes</p>
              <h2>Draft while the meeting is still running</h2>
            </div>
            <span className="panel-note">
              Model: {config?.suggestionModel ?? "Loading..."}
            </span>
          </div>

          <div className="summary-card">
            <span className="summary-label">Current read</span>
            <p>{analysis?.summary || liveSummaryMessage}</p>
          </div>

          <label className="field minutes-field">
            <span>Minutes draft</span>
            <textarea
              value={minutesDraft}
              onChange={(event) => setMinutesDraft(event.target.value)}
              placeholder="The generated meeting minutes draft will appear here."
            />
          </label>

          <div className="split-list">
            <section>
              <h3>Decisions</h3>
              {renderSimpleList(
                analysis?.decisions,
                "No clear decisions captured yet.",
              )}
            </section>

            <section>
              <h3>Action Items</h3>
              {analysis?.actionItems?.length ? (
                <ul className="plain-list">
                  {analysis.actionItems.map((item, index) => (
                    <li key={`${item.task}-${index}`}>
                      <strong>{item.task}</strong>
                      <span>
                        Owner: {item.owner} | Due: {item.due}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted-copy">No action items captured yet.</p>
              )}
            </section>
          </div>
        </section>

        <aside className="card panel sidebar-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Suggested Talking Points</p>
              <h2>Useful things to say next</h2>
            </div>
            <span className="panel-note">
              {analysisBusy ? "Analyzing..." : "Updates live"}
            </span>
          </div>

          <div className="suggestions-stack">
            {analysis?.speakingPoints?.length ? (
              analysis.speakingPoints.map((suggestion, index) => (
                <article key={`${suggestion.point}-${index}`} className="suggestion-card">
                  <div className="suggestion-topline">
                    <span className={`priority-badge priority-${suggestion.priority}`}>
                      {suggestion.priority}
                    </span>
                  </div>
                  <h3>{suggestion.point}</h3>
                  <p>{suggestion.reason}</p>
                </article>
              ))
            ) : (
              <div className="empty-state">
                {finalTranscript.length > 0
                  ? "The next analysis pass will turn your captured transcript into concrete talking points."
                  : "Suggested points will appear once the app captures usable transcript from the meeting."}
              </div>
            )}
          </div>

          <section className="list-card">
            <h3>Risks and blockers</h3>
            {renderSimpleList(analysis?.risks, "Nothing critical flagged yet.")}
          </section>

          <section className="list-card">
            <h3>Parking lot</h3>
            {renderSimpleList(
              analysis?.parkingLot,
              "No parking-lot topics identified yet.",
            )}
          </section>
        </aside>
      </main>
    </div>
  );
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

function mergeTranscriptSegment(
  current: TranscriptSegment[],
  incoming: TranscriptSegment,
) {
  const now = new Date().toISOString();
  const incomingText = incoming.text ?? "";
  const existing = current.find((segment) => segment.id === incoming.id);

  if (incoming.status === "partial" && !incomingText) {
    return current;
  }

  if (incoming.status === "final" && !incomingText.trim()) {
    return current.filter((segment) => segment.id !== incoming.id);
  }

  if (!existing) {
    return [
      ...current,
      {
        ...incoming,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  return current.map((segment) => {
    if (segment.id !== incoming.id) {
      return segment;
    }

    return {
      ...segment,
      text:
        incoming.status === "partial"
          ? `${segment.status === "partial" ? segment.text : ""}${incomingText}`
          : incomingText,
      status: incoming.status,
      updatedAt: now,
    };
  });
}

function renderSimpleList(items: string[] | undefined, fallback: string) {
  if (!items?.length) {
    return <p className="muted-copy">{fallback}</p>;
  }

  return (
    <ul className="plain-list">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

function captureStateHint(state: CaptureState) {
  if (state === "hearing-speech") return "Speech is being heard right now.";
  if (state === "processing-turn") return "Waiting for the transcript for the last spoken turn.";
  if (state === "listening") return "Ready for the next spoken turn.";
  return "Start the meeting to begin listening.";
}

function captureStateLabel(state: CaptureState) {
  if (state === "hearing-speech") return "Hearing speech";
  if (state === "processing-turn") return "Processing";
  if (state === "listening") return "Listening";
  return "Idle";
}

function getLiveSummaryMessage(
  status: SessionStatus,
  usableTurns: number,
  diagnostics: CaptureDiagnostics,
) {
  if (usableTurns > 0) {
    return "The current transcript is ready for analysis. Suggestions will update on the next analysis pass.";
  }

  if (status === "live" && diagnostics.state === "hearing-speech") {
    return "Speech is being detected. The app will draft minutes after the current turn settles.";
  }

  if (status === "live" && diagnostics.emptyTurns > 0) {
    return "The app is connected but has not captured usable speech yet. Check the microphone picker and mic signal card above.";
  }

  if (status === "live") {
    return "Listening for the first usable turn. Speak near the selected microphone and pause briefly so it can commit the turn.";
  }

  return "Once the transcript settles into full turns, the app will summarize the discussion here.";
}

function micLevelLabel(level: number, status: SessionStatus) {
  if (status !== "live") return "Mic meter appears when the meeting is live.";
  if (level >= 0.45) return "Strong signal";
  if (level >= 0.18) return "Moderate signal";
  return "Very quiet or no speech";
}

function describeDetectionStrength(score: number) {
  if (score >= 0.05) return "Strong";
  if (score >= 0.025) return "Usable";
  return "Quiet";
}

function statusLabel(status: SessionStatus) {
  if (status === "idle") return "Ready";
  if (status === "connecting") return "Connecting";
  if (status === "live") return "Live";
  if (status === "stopping") return "Stopping";
  return "Needs attention";
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
