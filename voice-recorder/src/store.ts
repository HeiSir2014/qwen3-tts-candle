import { join } from "path";
import { mkdir, unlink, rm, rename } from "fs/promises";
import { $ } from "bun";
import { createLogger } from "./logger";
import { EMBEDDING_EXTENSION } from "./tts-bridge";

const log = createLogger("store");

/** Pseudo profile that owns preset-voice (CustomVoice) TTS jobs. */
export const SYSTEM_PROFILE_ID = "__system__";

const DATA_DIR = join(import.meta.dir, "..", "data");
const PROFILES_FILE = join(DATA_DIR, "profiles.json");
const RECORDINGS_DIR = join(DATA_DIR, "recordings");
const TTS_DIR = join(DATA_DIR, "tts");
const TTS_JOBS_FILE = join(DATA_DIR, "tts-jobs.json");

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
}

async function ensureDirs() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(RECORDINGS_DIR, { recursive: true });
}

// ── Promise Lock ──
// Serializes read-modify-write operations on a single JSON file within this process.

function createLock() {
  let chain: Promise<void> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let resolve: () => void;
    chain = new Promise<void>((r) => (resolve = r));
    return prev.then(fn).finally(() => resolve!());
  };
}

const withProfilesLock = createLock();
const withTtsJobsLock = createLock();

// ── Atomic write: write to .tmp then rename ──

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpPath = filePath + ".tmp";
  await Bun.write(tmpPath, data);
  await rename(tmpPath, filePath);
}

// ── Profiles: load with fault tolerance ──

function migrateProfiles(profiles: Profile[]): Profile[] {
  for (const p of profiles) {
    for (const r of p.recordings) {
      if (!r.embeddingStatus) {
        r.embeddingStatus = "pending";
      }
    }
  }
  return profiles;
}

async function loadProfiles(): Promise<Profile[]> {
  await ensureDirs();
  const file = Bun.file(PROFILES_FILE);
  if (await file.exists()) {
    try {
      return migrateProfiles(await file.json());
    } catch (err) {
      log.error("Failed to load profiles.json, trying backup", { error: String(err) });
      const tmpFile = Bun.file(PROFILES_FILE + ".tmp");
      if (await tmpFile.exists()) {
        try {
          return migrateProfiles(await tmpFile.json());
        } catch {}
      }
      log.error("All profile data corrupted, starting fresh");
    }
  }
  return [];
}

async function saveProfiles(profiles: Profile[]): Promise<void> {
  await ensureDirs();
  await atomicWrite(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

export async function getProfiles(): Promise<Profile[]> {
  return loadProfiles();
}

export async function getProfile(id: string): Promise<Profile | undefined> {
  const profiles = await loadProfiles();
  return profiles.find((p) => p.id === id);
}

export async function createProfile(name: string, avatar: string): Promise<Profile> {
  return withProfilesLock(async () => {
    const profiles = await loadProfiles();
    const profile: Profile = {
      id: crypto.randomUUID(),
      name,
      avatar,
      createdAt: new Date().toISOString(),
      recordings: [],
    };
    profiles.push(profile);
    await saveProfiles(profiles);
    await mkdir(join(RECORDINGS_DIR, profile.id), { recursive: true });
    return profile;
  });
}

export async function deleteProfile(id: string): Promise<boolean> {
  return withProfilesLock(async () => {
    const profiles = await loadProfiles();
    const idx = profiles.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    profiles.splice(idx, 1);
    await saveProfiles(profiles);
    const dir = join(RECORDINGS_DIR, id);
    await rm(dir, { recursive: true, force: true });
    // Clean up TTS archive entries and files for this profile
    await withTtsJobsLock(async () => {
      const jobs = await loadTtsJobs();
      const remaining = jobs.filter((j) => j.profileId !== id);
      await saveTtsJobs(remaining);
    });
    const ttsDir = join(TTS_DIR, id);
    await rm(ttsDir, { recursive: true, force: true });
    return true;
  });
}

export async function getRecordings(profileId: string): Promise<Recording[]> {
  const profile = await getProfile(profileId);
  return profile?.recordings ?? [];
}

export async function addRecording(
  profileId: string,
  audioBuffer: ArrayBuffer,
  scriptId: string | null,
  scriptText: string
): Promise<Recording | null> {
  // Do file I/O (ffmpeg conversion) outside the lock to minimize lock hold time
  const recordingId = crypto.randomUUID();
  const filename = `${recordingId}.wav`;
  const dir = join(RECORDINGS_DIR, profileId);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `${recordingId}.tmp`);
  const wavPath = join(dir, filename);
  await Bun.write(tmpPath, audioBuffer);
  try {
    await $`ffmpeg -y -i ${tmpPath} -ar 24000 -ac 1 -sample_fmt s16 ${wavPath}`.quiet();
  } catch {
    await rename(tmpPath, wavPath);
  }
  await unlink(tmpPath).catch(() => {});

  return withProfilesLock(async () => {
    const profiles = await loadProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return null;

    const recording: Recording = {
      id: recordingId,
      scriptId,
      scriptText,
      filename,
      createdAt: new Date().toISOString(),
      embeddingStatus: "pending",
    };
    profile.recordings.push(recording);
    await saveProfiles(profiles);
    return recording;
  });
}

export async function deleteRecording(profileId: string, recordingId: string): Promise<boolean> {
  return withProfilesLock(async () => {
    const profiles = await loadProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return false;

    const idx = profile.recordings.findIndex((r) => r.id === recordingId);
    if (idx === -1) return false;

    const recording = profile.recordings[idx];
    const filepath = join(RECORDINGS_DIR, profileId, recording.filename);
    await unlink(filepath).catch(() => {});
    const embeddingPath = getEmbeddingPath(profileId, recordingId);
    await unlink(embeddingPath).catch(() => {});
    profile.recordings.splice(idx, 1);
    await saveProfiles(profiles);
    return true;
  });
}

export function getAudioPath(profileId: string, recordingId: string): string {
  return join(RECORDINGS_DIR, profileId, `${recordingId}.wav`);
}

export function getEmbeddingPath(profileId: string, recordingId: string): string {
  return join(RECORDINGS_DIR, profileId, `${recordingId}${EMBEDDING_EXTENSION}`);
}

export async function updateEmbeddingStatus(
  profileId: string,
  recordingId: string,
  status: EmbeddingStatus,
  error?: string
): Promise<void> {
  await withProfilesLock(async () => {
    const profiles = await loadProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    const recording = profile.recordings.find((r) => r.id === recordingId);
    if (!recording) return;
    recording.embeddingStatus = status;
    if (error !== undefined) {
      recording.embeddingError = error;
    } else {
      delete recording.embeddingError;
    }
    await saveProfiles(profiles);
  });
}

// ── TTS Job Persistence ──

export interface DialogSegment {
  profileId: string;
  profileName: string;
  text: string;
  chunkStart: number;
  chunkEnd: number;
}

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
  /** Preset speaker id for mode "tts" (profileId is SYSTEM_PROFILE_ID). */
  voice?: string;
  /** Style instruction for a preset voice, e.g. "用特别愤怒的语气说". */
  instruct?: string;
  dialogSegments?: DialogSegment[];
  profileIds?: string[];
  audioDurationS?: number;
}

async function loadTtsJobs(): Promise<TtsJob[]> {
  await mkdir(TTS_DIR, { recursive: true });
  const file = Bun.file(TTS_JOBS_FILE);
  if (await file.exists()) {
    try {
      return await file.json();
    } catch (err) {
      log.error("Failed to load tts-jobs.json, trying backup", { error: String(err) });
      const tmpFile = Bun.file(TTS_JOBS_FILE + ".tmp");
      if (await tmpFile.exists()) {
        try {
          return await tmpFile.json();
        } catch {}
      }
      log.error("All TTS job data corrupted, starting fresh");
    }
  }
  return [];
}

async function saveTtsJobs(jobs: TtsJob[]): Promise<void> {
  await atomicWrite(TTS_JOBS_FILE, JSON.stringify(jobs, null, 2));
}

export async function createTtsJob(
  profileId: string,
  recordingId: string,
  text: string,
  language: string,
  options?: {
    mode?: TtsJob["mode"];
    voice?: string;
    instruct?: string;
    dialogSegments?: DialogSegment[];
    profileIds?: string[];
  }
): Promise<TtsJob> {
  return withTtsJobsLock(async () => {
    const jobs = await loadTtsJobs();
    const job: TtsJob = {
      id: crypto.randomUUID(),
      profileId,
      recordingId,
      text,
      language,
      status: "processing",
      createdAt: new Date().toISOString(),
      ...(options?.mode && { mode: options.mode }),
      ...(options?.voice && { voice: options.voice }),
      ...(options?.instruct && { instruct: options.instruct }),
      ...(options?.dialogSegments && { dialogSegments: options.dialogSegments }),
      ...(options?.profileIds && { profileIds: options.profileIds }),
    };
    jobs.push(job);
    await saveTtsJobs(jobs);
    return job;
  });
}

export async function completeTtsJob(
  jobId: string,
  wavBuffer: ArrayBuffer | null,
  durationMs: number,
  extra?: { audioDurationS?: number; dialogSegments?: DialogSegment[] }
): Promise<TtsJob | null> {
  return withTtsJobsLock(async () => {
    const jobs = await loadTtsJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return null;

    if (wavBuffer) {
      const dir = join(TTS_DIR, job.profileId);
      await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, `${job.id}.wav`), wavBuffer);
    }

    job.status = "completed";
    job.durationMs = durationMs;
    job.completedAt = new Date().toISOString();
    if (extra?.audioDurationS !== undefined) job.audioDurationS = extra.audioDurationS;
    if (extra?.dialogSegments) job.dialogSegments = extra.dialogSegments;
    await saveTtsJobs(jobs);
    return job;
  });
}

export async function failTtsJob(jobId: string, error: string): Promise<void> {
  await withTtsJobsLock(async () => {
    const jobs = await loadTtsJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    job.status = "failed";
    job.error = error;
    job.completedAt = new Date().toISOString();
    await saveTtsJobs(jobs);
  });
}

export async function getTtsJob(jobId: string): Promise<TtsJob | undefined> {
  const jobs = await loadTtsJobs();
  return jobs.find((j) => j.id === jobId);
}

/**
 * Mark any "processing" jobs as "failed" on server startup.
 * These jobs can't survive a server restart — the generation process is gone.
 */
export async function cleanupStaleJobs(): Promise<number> {
  return withTtsJobsLock(async () => {
    const jobs = await loadTtsJobs();
    let cleaned = 0;
    for (const job of jobs) {
      if (job.status === "processing") {
        job.status = "failed";
        job.error = "Server restarted during generation";
        job.completedAt = new Date().toISOString();
        cleaned++;
      }
    }
    if (cleaned > 0) {
      await saveTtsJobs(jobs);
    }
    return cleaned;
  });
}

export async function getTtsHistory(profileId: string): Promise<TtsJob[]> {
  const jobs = await loadTtsJobs();
  return jobs.filter(
    (j) => j.profileId === profileId || (j.profileIds && j.profileIds.includes(profileId))
  );
}

export async function deleteTtsJob(jobId: string): Promise<boolean> {
  return withTtsJobsLock(async () => {
    const jobs = await loadTtsJobs();
    const idx = jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;
    const job = jobs[idx];
    if (job.status === "completed") {
      const filepath = join(TTS_DIR, job.profileId, `${job.id}.wav`);
      await unlink(filepath).catch(() => {});
    }
    jobs.splice(idx, 1);
    await saveTtsJobs(jobs);
    return true;
  });
}

export function getTtsAudioPath(profileId: string, jobId: string): string {
  return join(TTS_DIR, profileId, `${jobId}.wav`);
}

// ── Streaming chunk helpers ──

export function getTtsChunkPath(profileId: string, jobId: string, chunkIndex: number): string {
  return join(TTS_DIR, profileId, `${jobId}_chunk_${chunkIndex}.raw`);
}

export async function updateTtsJobProgress(
  jobId: string,
  chunksCompleted: number,
  chunksTotal: number
): Promise<void> {
  await withTtsJobsLock(async () => {
    const jobs = await loadTtsJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    job.chunksCompleted = chunksCompleted;
    job.chunksTotal = chunksTotal;
    await saveTtsJobs(jobs);
  });
}

export async function saveTtsChunk(
  profileId: string,
  jobId: string,
  chunkIndex: number,
  pcmData: Uint8Array
): Promise<void> {
  const dir = join(TTS_DIR, profileId);
  await mkdir(dir, { recursive: true });
  await Bun.write(getTtsChunkPath(profileId, jobId, chunkIndex), pcmData);
}

function writeWavHeader(buf: Uint8Array, dataSize: number, sampleRate: number, channels: number, bitsPerSample: number) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  // RIFF header
  buf.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + dataSize, true);
  buf.set(new TextEncoder().encode("WAVE"), 8);
  // fmt subchunk
  buf.set(new TextEncoder().encode("fmt "), 12);
  view.setUint32(16, 16, true); // subchunk1 size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data subchunk
  buf.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, dataSize, true);
}

export async function finalizeTtsChunks(
  profileId: string,
  jobId: string,
  totalChunks: number,
  sampleRate: number
): Promise<ArrayBuffer> {
  // Read all chunk files and concatenate PCM data
  const pcmParts: Uint8Array[] = [];
  let totalPcmBytes = 0;
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = getTtsChunkPath(profileId, jobId, i);
    const file = Bun.file(chunkPath);
    const data = new Uint8Array(await file.arrayBuffer());
    pcmParts.push(data);
    totalPcmBytes += data.byteLength;
  }

  // Build WAV file (44-byte header + PCM data)
  const wavBuf = new Uint8Array(44 + totalPcmBytes);
  writeWavHeader(wavBuf, totalPcmBytes, sampleRate, 1, 16);
  let offset = 44;
  for (const part of pcmParts) {
    wavBuf.set(part, offset);
    offset += part.byteLength;
  }

  // Write final WAV
  const dir = join(TTS_DIR, profileId);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, `${jobId}.wav`), wavBuf);

  // Schedule deferred cleanup of chunk files (give clients time to fetch)
  setTimeout(async () => {
    for (let i = 0; i < totalChunks; i++) {
      await unlink(getTtsChunkPath(profileId, jobId, i)).catch(() => {});
    }
  }, 30_000);

  return wavBuf.buffer;
}

export async function buildChunkWav(
  profileId: string,
  jobId: string,
  chunkIndex: number,
  sampleRate: number
): Promise<Uint8Array | null> {
  // Try raw chunk file first (available during streaming)
  const chunkPath = getTtsChunkPath(profileId, jobId, chunkIndex);
  const file = Bun.file(chunkPath);
  if (await file.exists()) {
    const pcmData = new Uint8Array(await file.arrayBuffer());
    const wav = new Uint8Array(44 + pcmData.byteLength);
    writeWavHeader(wav, pcmData.byteLength, sampleRate, 1, 16);
    wav.set(pcmData, 44);
    return wav;
  }

  // Fallback: serve the finalized full WAV if chunks were already cleaned up
  const wavPath = getTtsAudioPath(profileId, jobId);
  const wavFile = Bun.file(wavPath);
  if (await wavFile.exists()) {
    return new Uint8Array(await wavFile.arrayBuffer());
  }

  return null;
}
