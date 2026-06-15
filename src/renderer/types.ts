export type DelayOption = "minimal" | "low" | "medium" | "high" | "xhigh";
export type SessionStatus =
  | "idle"
  | "connecting"
  | "live"
  | "stopping"
  | "error";
export type TranscriptStatus = "partial" | "final";
export type CaptureState = "idle" | "listening" | "hearing-speech" | "processing-turn";

export interface AppConfig {
  hasApiKey: boolean;
  defaultLanguage: string;
  transcriptionDelay: DelayOption;
  realtimeTranscriptionModel: string;
  suggestionModel: string;
  analysisIntervalMs: number;
}

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

export interface AudioInputDetectionSample {
  averageLevel: number;
  deviceId: string;
  label: string;
  peakLevel: number;
  score: number;
}

export interface AudioInputDetectionResult {
  recommendedDeviceId: string;
  recommendedLabel: string;
  samples: AudioInputDetectionSample[];
  sufficientSignal: boolean;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  status: TranscriptStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureDiagnostics {
  audioLevel: number;
  committedTurns: number;
  emptyTurns: number;
  inputDeviceLabel: string;
  lastHeardAt: string | null;
  lastTranscriptAt: string | null;
  state: CaptureState;
}

export interface SpeakingPoint {
  point: string;
  reason: string;
  priority: "high" | "medium" | "low";
}

export interface ActionItem {
  owner: string;
  task: string;
  due: string;
}

export interface AnalysisResult {
  summary: string;
  speakingPoints: SpeakingPoint[];
  decisions: string[];
  risks: string[];
  parkingLot: string[];
  actionItems: ActionItem[];
  minutesDraft: string;
  generatedAt: string;
}

export interface MeetingAnalysisPayload {
  title: string;
  participants: string[];
  manualNotes: string;
  minutesDraft: string;
  transcriptSegments: TranscriptSegment[];
}

export interface MeetingExportPayload extends MeetingAnalysisPayload {
  analysis: AnalysisResult | null;
}

export interface RealtimeTokenRequest {
  language: string;
  delay: DelayOption;
}

export interface RealtimeTokenResponse {
  value: string;
  expiresAt?: number | string;
}
