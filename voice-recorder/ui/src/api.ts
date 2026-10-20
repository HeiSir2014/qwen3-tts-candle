import type { Profile, Recording, Script, SystemProfile, TtsJob } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg =
      (body as any).error?.message ?? (body as any).error ?? res.statusText;
    throw new Error(msg);
  }
  return res.json();
}

// ── Profiles ──

export function getProfiles(): Promise<Profile[]> {
  return fetch("/api/profiles").then((r) => json<Profile[]>(r));
}

export function createProfile(
  name: string,
  avatar: string
): Promise<Profile> {
  return fetch("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, avatar }),
  }).then((r) => json<Profile>(r));
}

export function deleteProfile(id: string): Promise<void> {
  return fetch(`/api/profiles/${id}`, { method: "DELETE" }).then(() => {});
}

// ── Recordings ──

export function getRecordings(profileId: string): Promise<Recording[]> {
  return fetch(`/api/profiles/${profileId}/recordings`).then((r) =>
    json<Recording[]>(r)
  );
}

export function uploadRecording(
  profileId: string,
  blob: Blob,
  scriptId: string | null,
  scriptText: string
): Promise<Recording> {
  const fd = new FormData();
  fd.append("audio", blob, "recording.wav");
  if (scriptId) fd.append("scriptId", scriptId);
  fd.append("scriptText", scriptText || "");
  return fetch(`/api/profiles/${profileId}/recordings`, {
    method: "POST",
    body: fd,
  }).then((r) => json<Recording>(r));
}

export function deleteRecording(
  profileId: string,
  recordingId: string
): Promise<void> {
  return fetch(`/api/profiles/${profileId}/recordings/${recordingId}`, {
    method: "DELETE",
  }).then(() => {});
}

// ── Audio ──

export function audioUrl(profileId: string, recordingId: string): string {
  return `/api/audio/${profileId}/${recordingId}`;
}

// ── Scripts ──

export function getScripts(): Promise<Script[]> {
  return fetch("/api/scripts").then((r) => json<Script[]>(r));
}

// ── Clone ──

export function cloneSubmit(
  profileId: string,
  recordingId: string,
  text: string,
  language: string
): Promise<{ jobId: string }> {
  return fetch("/api/clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId, recordingId, text, language }),
  }).then((r) => json<{ jobId: string }>(r));
}

export function cloneDialogSubmit(
  text: string,
  language: string,
  profileMapping: Record<string, { profileId: string; recordingId: string }>
): Promise<{ jobId: string }> {
  return fetch("/api/clone-dialog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language, profileMapping }),
  }).then((r) => json<{ jobId: string }>(r));
}

export function getSystemProfiles(): Promise<SystemProfile[]> {
  return fetch("/api/system-profiles").then((r) => json<SystemProfile[]>(r));
}

export function ttsSubmit(
  voice: string,
  text: string,
  language: string
): Promise<{ jobId: string }> {
  return fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice, text, language }),
  }).then((r) => json<{ jobId: string }>(r));
}

export function cloneJobStatus(
  jobId: string
): Promise<{
  status: string;
  error?: string;
  durationMs?: number;
  chunksCompleted?: number;
  chunksTotal?: number;
}> {
  return fetch(`/api/clone-jobs/${jobId}`).then((r) => json(r));
}

export async function cloneJobChunkAudio(
  jobId: string,
  chunkIndex: number
): Promise<Blob> {
  const r = await fetch(`/api/clone-jobs/${jobId}/chunk/${chunkIndex}`);
  if (!r.ok) throw new Error("Failed to download chunk");
  return r.blob();
}

export function cloneJobEvents(jobId: string): EventSource {
  return new EventSource(`/api/clone-jobs/${jobId}/events`);
}

export async function cloneJobResult(jobId: string): Promise<Blob> {
  const r = await fetch(`/api/clone-jobs/${jobId}/result`);
  if (!r.ok) throw new Error("Failed to download result");
  return r.blob();
}

// ── Embedding ──

export function embeddingStatus(
  profileId: string,
  recordingId: string
): Promise<{ status: string; error?: string }> {
  return fetch(
    `/api/profiles/${profileId}/recordings/${recordingId}/embedding-status`
  ).then((r) => json(r));
}

export function retryEmbedding(
  profileId: string,
  recordingId: string
): Promise<void> {
  return fetch(
    `/api/profiles/${profileId}/recordings/${recordingId}/retry-embedding`,
    { method: "POST" }
  ).then(() => {});
}

// ── TTS Status ──

export function ttsStatus(): Promise<{ available: boolean }> {
  return fetch("/api/tts-status").then((r) => json(r));
}

// ── TTS History ──

export function getTtsHistory(profileId: string): Promise<TtsJob[]> {
  return fetch(`/api/profiles/${profileId}/tts-history`).then((r) =>
    json<TtsJob[]>(r)
  );
}

export function deleteTtsJob(ttsId: string): Promise<void> {
  return fetch(`/api/tts/${ttsId}`, { method: "DELETE" }).then(() => {});
}

export function ttsAudioUrl(profileId: string, ttsId: string): string {
  return `/api/tts-audio/${profileId}/${ttsId}`;
}
