import type {
  AnalysisResult,
  AppConfig,
  MeetingAnalysisPayload,
  MeetingExportPayload,
  RealtimeTokenRequest,
  RealtimeTokenResponse,
} from "./types";

interface MeetingApi {
  getConfig: () => Promise<AppConfig>;
  createRealtimeToken: (
    options: RealtimeTokenRequest,
  ) => Promise<RealtimeTokenResponse>;
  analyzeMeeting: (payload: MeetingAnalysisPayload) => Promise<AnalysisResult>;
  exportMinutes: (
    payload: MeetingExportPayload,
  ) => Promise<{ canceled: boolean; filePath?: string }>;
}

const browserFallback: MeetingApi = {
  async getConfig() {
    return {
      hasApiKey: false,
      defaultLanguage: "en",
      transcriptionDelay: "low",
      realtimeTranscriptionModel: "gpt-realtime-whisper",
      suggestionModel: "gpt-5.5",
      analysisIntervalMs: 20000,
    };
  },

  async createRealtimeToken(_options: RealtimeTokenRequest) {
    throw new Error("Live transcription is only available inside the Electron app.");
  },

  async analyzeMeeting(payload: MeetingAnalysisPayload) {
    const transcriptText = payload.transcriptSegments
      .filter((segment) => segment.status === "final")
      .map((segment) => segment.text)
      .join(" ");

    return {
      summary:
        transcriptText ||
        "Browser preview mode is active. Open the desktop app to use live OpenAI analysis.",
      speakingPoints: transcriptText
        ? [
            {
              point: "Recap the most important takeaway so far.",
              reason:
                "This preview mode cannot call OpenAI, so it shows a static example card instead.",
              priority: "medium",
            },
          ]
        : [],
      decisions: [],
      risks: [],
      parkingLot: [],
      actionItems: [],
      minutesDraft: payload.minutesDraft,
      generatedAt: new Date().toISOString(),
    };
  },

  async exportMinutes(_payload: MeetingExportPayload) {
    return { canceled: true };
  },
};

export const meetingApi: MeetingApi = window.meetingApi ?? browserFallback;
