import type {
  AudioInputDetectionResult,
  AudioInputDetectionSample,
  AudioInputDevice,
} from "../types";

const SAMPLE_DURATION_MS = 1500;
const SAMPLE_INTERVAL_MS = 90;
const SIGNAL_THRESHOLD = 0.015;
const WARMUP_MS = 250;

export const defaultAudioInputs: AudioInputDevice[] = [
  { deviceId: "", label: "System default microphone" },
];

export async function enumerateAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return defaultAudioInputs;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label?.trim() || `Microphone ${index + 1}`,
      }));

    if (audioInputs.length === 0) {
      return defaultAudioInputs;
    }

    return [defaultAudioInputs[0], ...audioInputs];
  } catch {
    return defaultAudioInputs;
  }
}

export async function detectBestAudioInput(
  devices: AudioInputDevice[],
): Promise<AudioInputDetectionResult> {
  const testableDevices = devices.filter((device) => device.deviceId);
  const samples: AudioInputDetectionSample[] = [];

  for (const device of testableDevices) {
    samples.push(await sampleAudioInput(device));
  }

  const rankedSamples = samples.sort((left, right) => right.score - left.score);
  const bestSample = rankedSamples[0];

  return {
    recommendedDeviceId: bestSample?.deviceId || "",
    recommendedLabel: bestSample?.label || "System default microphone",
    samples: rankedSamples,
    sufficientSignal: Boolean(bestSample && bestSample.score >= SIGNAL_THRESHOLD),
  };
}

async function sampleAudioInput(
  device: AudioInputDevice,
): Promise<AudioInputDetectionSample> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: true,
      channelCount: 1,
      deviceId: { exact: device.deviceId },
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;

  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  const buffer = new Uint8Array(analyser.fftSize);
  const levels: number[] = [];

  try {
    await delay(WARMUP_MS);

    const startedAt = performance.now();
    while (performance.now() - startedAt < SAMPLE_DURATION_MS) {
      analyser.getByteTimeDomainData(buffer);
      levels.push(calculateRms(buffer));
      await delay(SAMPLE_INTERVAL_MS);
    }
  } finally {
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await audioContext.close().catch(() => undefined);
  }

  const peakLevel = levels.length ? Math.max(...levels) : 0;
  const averageLevel = levels.length
    ? levels.reduce((sum, level) => sum + level, 0) / levels.length
    : 0;
  const hotWindowAverage = computeHotWindowAverage(levels);
  const score = peakLevel * 0.65 + hotWindowAverage * 0.35;

  return {
    averageLevel,
    deviceId: device.deviceId,
    label: device.label,
    peakLevel,
    score,
  };
}

function calculateRms(buffer: Uint8Array) {
  let sumSquares = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const sample = (buffer[index] - 128) / 128;
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / buffer.length);
}

function computeHotWindowAverage(levels: number[]) {
  if (levels.length === 0) {
    return 0;
  }

  const sorted = [...levels].sort((left, right) => right - left);
  const hotWindowSize = Math.max(3, Math.ceil(sorted.length / 4));
  const hotWindow = sorted.slice(0, hotWindowSize);
  return hotWindow.reduce((sum, level) => sum + level, 0) / hotWindow.length;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
