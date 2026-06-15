import type {
  AppConfig,
  MeetingAnalysisPayload,
  MeetingExportPayload,
  RealtimeTokenRequest,
  RealtimeTokenResponse,
  AnalysisResult,
} from "./types";

declare global {
  interface Window {
    meetingApi?: {
      getConfig: () => Promise<AppConfig>;
      createRealtimeToken: (
        options: RealtimeTokenRequest,
      ) => Promise<RealtimeTokenResponse>;
      analyzeMeeting: (
        payload: MeetingAnalysisPayload,
      ) => Promise<AnalysisResult>;
      exportMinutes: (
        payload: MeetingExportPayload,
      ) => Promise<{ canceled: boolean; filePath?: string }>;
    };
  }
}

export {};
