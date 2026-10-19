export type EmbeddingStatus = "pending" | "processing" | "ready" | "failed";

export interface Recording {
  id: string;
  scriptId: string | null;
  scriptText: string;
  filename: string;
  createdAt: string;
  embeddingStatus: EmbeddingStatus;
  embeddingError?: string;
}

export interface Profile {
  id: string;
  name: string;
  avatar: string;
  createdAt: string;
  recordings: Recording[];
  recordingCount?: number;
}

/** Preset voice of the CustomVoice model; its jobs live under SYSTEM_PROFILE_ID. */
export interface SystemProfile {
  id: string;
  name: string;
  description: string;
}

export const SYSTEM_PROFILE_ID = "__system__";

export interface TtsJob {
  id: string;
  profileId: string;
  recordingId: string;
  text: string;
  language: string;
  status: "processing" | "completed" | "failed";
  error?: string;
  durationMs?: number;
  createdAt: string;
  completedAt?: string;
  chunksCompleted?: number;
  chunksTotal?: number;
  mode?: "single" | "dialog" | "tts";
  voice?: string;
  dialogSegments?: { profileName: string; text: string }[];
  profileIds?: string[];
  audioDurationS?: number;
}

export interface Script {
  id: string;
  language: "zh" | "en";
  category: string;
  text: string;
}

export type Lang = "en" | "zh";
