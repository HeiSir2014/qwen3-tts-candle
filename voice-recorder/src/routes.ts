import {
  getProfiles,
  getProfile,
  createProfile,
  deleteProfile,
  addRecording,
  deleteRecording,
  getAudioPath,
  getEmbeddingPath,
  updateEmbeddingStatus,
  createTtsJob,
  completeTtsJob,
  failTtsJob,
  getTtsJob,
  getTtsHistory,
  deleteTtsJob,
  getTtsAudioPath,
  updateTtsJobProgress,
  saveTtsChunk,
  finalizeTtsChunks,
  buildChunkWav,
  SYSTEM_PROFILE_ID,
  type TtsJob,
  type DialogSegment,
} from "./store";
import { SCRIPTS } from "./scripts";
import {
  requestCloneStream,
  requestTtsStream,
  checkTtsHealth,
  requestExtractEmbedding,
  fetchSystemVoices,
  TTS_BACKEND,
  type CloneStreamChunk,
} from "./tts-bridge";
import { emitJobEvent, onJobEvent, type JobEvent } from "./job-events";
import { createLogger } from "./logger";
import {
  generateRequestId,
  checkRateLimit,
  sanitizeString,
  validateUUID,
  errorResponse,
  logRequest,
} from "./middleware";

const log = createLogger("routes");

function json(data: unknown, status = 200, requestId?: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (requestId) headers["X-Request-Id"] = requestId;
  return new Response(JSON.stringify(data), { status, headers });
}

function jobSnapshot(job: TtsJob) {
  return {
    status: job.status,
    error: job.error,
    durationMs: job.durationMs,
    chunksCompleted: job.chunksCompleted ?? 0,
    chunksTotal: job.chunksTotal ?? 0,
    mode: job.mode,
    dialogSegments: job.dialogSegments,
    profileIds: job.profileIds,
    audioDurationS: job.audioDurationS,
  };
}

interface ParsedSegment {
  profileName: string;
  text: string;
}

function parseDialogText(text: string): ParsedSegment[] {
  const regex = /\[([^\]]+)\]/g;
  const segments: ParsedSegment[] = [];
  let lastIndex = 0;
  let currentProfile: string | null = null;

  for (const match of text.matchAll(regex)) {
    if (currentProfile && match.index! > lastIndex) {
      const segText = text.slice(lastIndex, match.index!).trim();
      if (segText) segments.push({ profileName: currentProfile, text: segText });
    }
    currentProfile = match[1]!;
    lastIndex = match.index! + match[0].length;
  }
  if (currentProfile && lastIndex < text.length) {
    const segText = text.slice(lastIndex).trim();
    if (segText) segments.push({ profileName: currentProfile, text: segText });
  }
  return segments;
}

export async function triggerEmbeddingExtraction(profileId: string, recordingId: string, scriptText: string): Promise<void> {
  try {
    const healthy = await checkTtsHealth();
    if (!healthy) {
      log.info(`TTS server not ready, skipping embedding extraction for ${recordingId}`);
      return;
    }

    await updateEmbeddingStatus(profileId, recordingId, "processing");

    const refAudioPath = getAudioPath(profileId, recordingId);
    const outputPath = getEmbeddingPath(profileId, recordingId);

    await requestExtractEmbedding({
      ref_audio_path: refAudioPath,
      ref_text: scriptText,
      output_path: outputPath,
    });

    await updateEmbeddingStatus(profileId, recordingId, "ready");
    log.info(`Embedding ready for recording ${recordingId}`);
  } catch (err: any) {
    log.error(`Embedding extraction failed for ${recordingId}`, { error: err.message });
    await updateEmbeddingStatus(profileId, recordingId, "failed", err.message);
  }
}

/**
 * Drain a TTS frame stream into a persistent job: save chunks, emit progress
 * events, then finalize the WAV. Runs fire-and-forget after the 202 response.
 */
async function runStreamingJob(
  job: TtsJob,
  stream: AsyncGenerator<CloneStreamChunk, void, undefined>,
  requestId: string
): Promise<void> {
  const profileId = job.profileId;
  const startTime = Date.now();
  try {
    let lastSampleRate = 24000;
    let chunksReceived = 0;
    let totalPcmBytes = 0;
    let firstChunkTime: number | null = null;

    for await (const chunk of stream) {
      const now = Date.now();
      if (firstChunkTime === null) {
        firstChunkTime = now;
        log.info("Clone first chunk received (TTFB)", {
          jobId: job.id, requestId,
          ttfbMs: now - startTime,
          chunkIndex: chunk.chunkIndex,
          pcmBytes: chunk.pcmData.byteLength,
          sampleRate: chunk.sampleRate,
        });
      }

      await saveTtsChunk(profileId, job.id, chunk.chunkIndex, chunk.pcmData);
      chunksReceived = chunk.chunkIndex + 1;
      totalPcmBytes += chunk.pcmData.byteLength;
      // In true streaming mode totalChunks is 0xFFFFFFFE (unknown), pass 0 to indicate streaming
      const reportTotal = chunk.totalChunks === 0xFFFFFFFE ? 0 : chunk.totalChunks;
      await updateTtsJobProgress(job.id, chunksReceived, reportTotal);
      lastSampleRate = chunk.sampleRate;

      emitJobEvent({
        type: "chunk_ready",
        jobId: job.id,
        data: { chunkIndex: chunk.chunkIndex, chunksCompleted: chunksReceived, chunksTotal: reportTotal },
      });

      log.info("Clone chunk saved", {
        jobId: job.id, requestId,
        chunkIndex: chunk.chunkIndex,
        chunksReceived,
        pcmBytes: chunk.pcmData.byteLength,
        elapsedMs: now - startTime,
      });
    }

    // Finalize: concatenate all chunks into a single WAV
    if (chunksReceived > 0) {
      const finalizeStart = Date.now();
      await finalizeTtsChunks(profileId, job.id, chunksReceived, lastSampleRate);
      log.info("Clone chunks finalized", {
        jobId: job.id, requestId,
        totalChunks: chunksReceived,
        finalizeMs: Date.now() - finalizeStart,
      });
    }

    const durationMs = Date.now() - startTime;
    const estimatedAudioS = totalPcmBytes / (lastSampleRate * 2); // 16-bit mono
    await completeTtsJob(job.id, null, durationMs, {
      audioDurationS: Math.round(estimatedAudioS * 100) / 100,
    });

    emitJobEvent({
      type: "completed",
      jobId: job.id,
      data: { durationMs, chunksTotal: chunksReceived },
    });

    log.info("Clone job completed", {
      jobId: job.id, requestId,
      durationMs,
      totalChunks: chunksReceived,
      totalPcmBytes,
      estimatedAudioS: Math.round(estimatedAudioS * 100) / 100,
      ttfbMs: firstChunkTime ? firstChunkTime - startTime : null,
    });
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    await failTtsJob(job.id, err.message);

    emitJobEvent({
      type: "failed",
      jobId: job.id,
      data: { error: err.message },
    });

    log.error("Clone job failed", {
      jobId: job.id, requestId,
      error: err.message,
      durationMs,
      chunksReceived: 0,
    });
  }
}

export async function handleApi(req: Request, path: string, clientIp: string): Promise<Response | null> {
  const requestId = generateRequestId();
  const logEnd = logRequest(requestId, req.method, path, clientIp);
  const method = req.method;

  try {
    // Rate limiting — only for write operations (POST/DELETE), not GET reads
    if (method !== "GET") {
      const isClone = path === "/api/clone" || path === "/api/clone-dialog" || path === "/api/tts";
      const rl = checkRateLimit(clientIp, isClone);
      if (!rl.allowed) {
        const retrySeconds = Math.ceil((rl.retryAfterMs || 60000) / 1000);
        return errorResponse(
          "RATE_LIMITED",
          `Too many requests. Retry after ${retrySeconds} seconds.`,
          requestId,
          429
        );
      }
    }

    // GET /api/scripts
    if (method === "GET" && path === "/api/scripts") {
      return json(SCRIPTS, 200, requestId);
    }

    // GET /api/profiles
    if (method === "GET" && path === "/api/profiles") {
      const profiles = await getProfiles();
      return json(
        profiles.map((p) => ({
          ...p,
          recordingCount: p.recordings.length,
        })),
        200,
        requestId
      );
    }

    // POST /api/profiles
    if (method === "POST" && path === "/api/profiles") {
      const body = await req.json();
      const { name, avatar } = body;
      if (!name) return errorResponse("BAD_REQUEST", "Name is required", requestId, 400);
      const profile = await createProfile(sanitizeString(name, 100), avatar || "🎤");
      return json(profile, 201, requestId);
    }

    // DELETE /api/profiles/:id
    const deleteProfileMatch = path.match(/^\/api\/profiles\/([^/]+)$/);
    if (method === "DELETE" && deleteProfileMatch) {
      const id = deleteProfileMatch[1];
      if (!validateUUID(id)) return errorResponse("BAD_REQUEST", "Invalid profileId", requestId, 400);
      const ok = await deleteProfile(id);
      return ok ? json({ ok: true }, 200, requestId) : errorResponse("NOT_FOUND", "Profile not found", requestId, 404);
    }

    // GET /api/profiles/:id/recordings
    const getRecordingsMatch = path.match(/^\/api\/profiles\/([^/]+)\/recordings$/);
    if (method === "GET" && getRecordingsMatch) {
      const profile = await getProfile(getRecordingsMatch[1]);
      if (!profile) return errorResponse("NOT_FOUND", "Profile not found", requestId, 404);
      return json(profile.recordings, 200, requestId);
    }

    // POST /api/profiles/:id/recordings
    if (method === "POST" && getRecordingsMatch) {
      const profileId = getRecordingsMatch[1];
      const profile = await getProfile(profileId);
      if (!profile) return errorResponse("NOT_FOUND", "Profile not found", requestId, 404);

      const formData = await req.formData();
      const audio = formData.get("audio");
      const scriptId = formData.get("scriptId") as string | null;
      const scriptText = (formData.get("scriptText") as string) || "";

      if (!audio || !(audio instanceof Blob)) {
        return errorResponse("BAD_REQUEST", "Audio file is required", requestId, 400);
      }

      const buffer = await audio.arrayBuffer();
      const recording = await addRecording(profileId, buffer, scriptId, scriptText);
      if (!recording) return errorResponse("NOT_FOUND", "Profile not found", requestId, 404);

      // Fire-and-forget embedding extraction
      triggerEmbeddingExtraction(profileId, recording.id, scriptText).catch(() => {});

      return json(recording, 201, requestId);
    }

    // DELETE /api/profiles/:id/recordings/:rid
    const deleteRecordingMatch = path.match(
      /^\/api\/profiles\/([^/]+)\/recordings\/([^/]+)$/
    );
    if (method === "DELETE" && deleteRecordingMatch) {
      const ok = await deleteRecording(deleteRecordingMatch[1], deleteRecordingMatch[2]);
      return ok ? json({ ok: true }, 200, requestId) : errorResponse("NOT_FOUND", "Recording not found", requestId, 404);
    }

    // GET /api/audio/:profileId/:recordingId
    const audioMatch = path.match(/^\/api\/audio\/([^/]+)\/([^/]+)$/);
    if (method === "GET" && audioMatch) {
      const audioPath = getAudioPath(audioMatch[1], audioMatch[2]);
      const file = Bun.file(audioPath);
      if (!(await file.exists())) return errorResponse("NOT_FOUND", "Audio not found", requestId, 404);
      return new Response(file, {
        headers: { "Content-Type": "audio/wav", "X-Request-Id": requestId },
      });
    }

    // POST /api/clone — submit async job, returns jobId immediately
    if (method === "POST" && path === "/api/clone") {
      const healthy = await checkTtsHealth();
      if (!healthy) {
        return errorResponse("SERVICE_UNAVAILABLE", "TTS server is not available. Please wait for it to start.", requestId, 503);
      }

      const body = await req.json();
      const { profileId, recordingId, language } = body;
      const text = sanitizeString(body.text || "");
      if (!profileId || !recordingId || !text) {
        return errorResponse("BAD_REQUEST", "profileId, recordingId, and text are required", requestId, 400);
      }
      if (!validateUUID(profileId)) {
        return errorResponse("BAD_REQUEST", "Invalid profileId format", requestId, 400);
      }

      const profile = await getProfile(profileId);
      if (!profile) return errorResponse("NOT_FOUND", "Profile not found", requestId, 404);

      const recording = profile.recordings.find((r) => r.id === recordingId);
      if (!recording) return errorResponse("NOT_FOUND", "Recording not found", requestId, 404);

      const refAudioPath = getAudioPath(profileId, recordingId);
      const refText = recording.scriptText;

      // Check if pre-computed embedding exists on disk
      const embeddingPath = getEmbeddingPath(profileId, recordingId);
      const embeddingFile = Bun.file(embeddingPath);
      const hasEmbedding = await embeddingFile.exists();

      // Create persistent job
      const job = await createTtsJob(profileId, recordingId, text, language || "Auto");

      log.info("Clone job created", { requestId, jobId: job.id, profileId });

      log.info("Clone stream iteration starting", {
        jobId: job.id, requestId, profileId,
        hasEmbedding, textLength: text.length,
      });

      // Fire-and-forget: run streaming generation in background
      runStreamingJob(
        job,
        requestCloneStream(
          {
            ref_audio_path: refAudioPath,
            ref_text: refText,
            text,
            language: language || "Auto",
            ...(hasEmbedding ? { embedding_path: embeddingPath } : {}),
          },
          requestId
        ),
        requestId
      );

      return json({ jobId: job.id }, 202, requestId);
    }

    // GET /api/system-profiles — preset voices of the CustomVoice model
    if (method === "GET" && path === "/api/system-profiles") {
      try {
        return json(await fetchSystemVoices(), 200, requestId);
      } catch (err: any) {
        return errorResponse("SERVICE_UNAVAILABLE", `TTS server is not available: ${err.message}`, requestId, 503);
      }
    }

    // POST /api/tts — preset-voice synthesis, same async job flow as /api/clone
    if (method === "POST" && path === "/api/tts") {
      const body = await req.json();
      const voice = typeof body.voice === "string" ? body.voice : "";
      const text = sanitizeString(body.text || "");
      const language = body.language || "Auto";
      if (!voice || !text) {
        return errorResponse("BAD_REQUEST", "voice and text are required", requestId, 400);
      }

      let voices;
      try {
        voices = await fetchSystemVoices();
      } catch {
        return errorResponse("SERVICE_UNAVAILABLE", "TTS server is not available. Please wait for it to start.", requestId, 503);
      }
      if (!voices.some((v) => v.id === voice)) {
        return errorResponse("BAD_REQUEST", `Unknown voice: ${voice}`, requestId, 400);
      }

      const job = await createTtsJob(SYSTEM_PROFILE_ID, voice, text, language, { mode: "tts", voice });
      log.info("TTS job created", { requestId, jobId: job.id, voice, textLength: text.length });

      // Fire-and-forget: run streaming generation in background
      runStreamingJob(job, requestTtsStream({ voice, text, language }, requestId), requestId);

      return json({ jobId: job.id }, 202, requestId);
    }

    // POST /api/clone-dialog — multi-profile dialog TTS
    if (method === "POST" && path === "/api/clone-dialog") {
      const healthy = await checkTtsHealth();
      if (!healthy) {
        return errorResponse("SERVICE_UNAVAILABLE", "TTS server is not available.", requestId, 503);
      }

      const body = await req.json();
      const { language, profileMapping } = body;
      const text = sanitizeString(body.text || "");
      if (!text || !profileMapping || typeof profileMapping !== "object") {
        return errorResponse("BAD_REQUEST", "text and profileMapping are required", requestId, 400);
      }

      const segments = parseDialogText(text);
      if (segments.length === 0) {
        return errorResponse("BAD_REQUEST", "No [SpeakerName] tags found in text", requestId, 400);
      }

      // Validate all speaker names have mappings
      const missingNames = segments
        .map((s) => s.profileName)
        .filter((name) => !profileMapping[name]);
      if (missingNames.length > 0) {
        return errorResponse("BAD_REQUEST", `Missing profile mapping for: ${[...new Set(missingNames)].join(", ")}`, requestId, 400);
      }

      // Validate all referenced profiles and recordings exist
      const profileCache = new Map<string, Awaited<ReturnType<typeof getProfile>>>();
      for (const name of Object.keys(profileMapping)) {
        const mapping = profileMapping[name];
        if (!mapping.profileId || !mapping.recordingId) {
          return errorResponse("BAD_REQUEST", `Invalid mapping for "${name}"`, requestId, 400);
        }
        if (!profileCache.has(mapping.profileId)) {
          const profile = await getProfile(mapping.profileId);
          if (!profile) return errorResponse("NOT_FOUND", `Profile not found for "${name}"`, requestId, 404);
          profileCache.set(mapping.profileId, profile);
        }
        const profile = profileCache.get(mapping.profileId)!;
        const recording = profile!.recordings.find((r) => r.id === mapping.recordingId);
        if (!recording) return errorResponse("NOT_FOUND", `Recording not found for "${name}"`, requestId, 404);
      }

      // Collect unique profile IDs; use first mapping's profileId as primary
      const allProfileIds = [...new Set(segments.map((s) => profileMapping[s.profileName].profileId))];
      const primaryProfileId = allProfileIds[0]!;
      const primaryRecordingId = profileMapping[segments[0]!.profileName].recordingId;

      const job = await createTtsJob(primaryProfileId, primaryRecordingId, text, language || "Auto", {
        mode: "dialog",
        profileIds: allProfileIds,
      });

      log.info("Dialog clone job created", {
        requestId, jobId: job.id,
        segmentCount: segments.length,
        profileCount: allProfileIds.length,
      });

      // Fire-and-forget: process segments sequentially
      const startTime = Date.now();
      (async () => {
        try {
          let globalChunkIndex = 0;
          let totalPcmBytes = 0;
          let lastSampleRate = 24000;
          const dialogSegments: DialogSegment[] = [];

          for (let segIdx = 0; segIdx < segments.length; segIdx++) {
            const seg = segments[segIdx]!;
            const mapping = profileMapping[seg.profileName];
            const segProfileId = mapping.profileId;
            const segRecordingId = mapping.recordingId;

            const profile = profileCache.get(segProfileId)!;
            const recording = profile!.recordings.find((r) => r.id === segRecordingId)!;
            const refAudioPath = getAudioPath(segProfileId, segRecordingId);
            const refText = recording.scriptText;

            const embeddingPath = getEmbeddingPath(segProfileId, segRecordingId);
            const hasEmbedding = await Bun.file(embeddingPath).exists();

            const segChunkStart = globalChunkIndex;

            log.info("Dialog segment starting", {
              jobId: job.id, requestId, segIdx,
              profileName: seg.profileName, textLength: seg.text.length,
            });

            for await (const chunk of requestCloneStream(
              {
                ref_audio_path: refAudioPath,
                ref_text: refText,
                text: seg.text,
                language: language || "Auto",
                ...(hasEmbedding ? { embedding_path: embeddingPath } : {}),
              },
              requestId
            )) {
              await saveTtsChunk(primaryProfileId, job.id, globalChunkIndex, chunk.pcmData);
              globalChunkIndex++;
              totalPcmBytes += chunk.pcmData.byteLength;
              lastSampleRate = chunk.sampleRate;

              await updateTtsJobProgress(job.id, globalChunkIndex, 0);

              emitJobEvent({
                type: "chunk_ready",
                jobId: job.id,
                data: {
                  chunkIndex: globalChunkIndex - 1,
                  chunksCompleted: globalChunkIndex,
                  chunksTotal: 0,
                  segmentIndex: segIdx,
                },
              });
            }

            dialogSegments.push({
              profileId: segProfileId,
              profileName: seg.profileName,
              text: seg.text,
              chunkStart: segChunkStart,
              chunkEnd: globalChunkIndex,
            });

            log.info("Dialog segment completed", {
              jobId: job.id, requestId, segIdx,
              profileName: seg.profileName,
              chunksInSegment: globalChunkIndex - segChunkStart,
            });
          }

          // Finalize: concatenate all chunks into a single WAV
          if (globalChunkIndex > 0) {
            await finalizeTtsChunks(primaryProfileId, job.id, globalChunkIndex, lastSampleRate);
          }

          const durationMs = Date.now() - startTime;
          const audioDurationS = totalPcmBytes / (lastSampleRate * 2); // 16-bit mono

          await completeTtsJob(job.id, null, durationMs, {
            audioDurationS: Math.round(audioDurationS * 100) / 100,
            dialogSegments,
          });

          emitJobEvent({
            type: "completed",
            jobId: job.id,
            data: { durationMs, chunksTotal: globalChunkIndex },
          });

          log.info("Dialog clone job completed", {
            jobId: job.id, requestId, durationMs,
            totalChunks: globalChunkIndex, totalPcmBytes,
            audioDurationS: Math.round(audioDurationS * 100) / 100,
            segmentCount: segments.length,
          });
        } catch (err: any) {
          const durationMs = Date.now() - startTime;
          await failTtsJob(job.id, err.message);

          emitJobEvent({
            type: "failed",
            jobId: job.id,
            data: { error: err.message },
          });

          log.error("Dialog clone job failed", {
            jobId: job.id, requestId,
            error: err.message, durationMs,
          });
        }
      })();

      return json({ jobId: job.id }, 202, requestId);
    }

    // GET /api/clone-jobs/:jobId — poll job status
    const cloneJobMatch = path.match(/^\/api\/clone-jobs\/([^/]+)$/);
    if (method === "GET" && cloneJobMatch) {
      const job = await getTtsJob(cloneJobMatch[1]);
      if (!job) return errorResponse("NOT_FOUND", "Job not found", requestId, 404);
      return json({
        status: job.status,
        error: job.error,
        durationMs: job.durationMs,
        chunksCompleted: job.chunksCompleted,
        chunksTotal: job.chunksTotal,
        mode: job.mode,
        dialogSegments: job.dialogSegments,
        profileIds: job.profileIds,
        audioDurationS: job.audioDurationS,
      }, 200, requestId);
    }

    // GET /api/clone-jobs/:jobId/events — SSE stream for job progress
    const cloneJobEventsMatch = path.match(/^\/api\/clone-jobs\/([^/]+)\/events$/);
    if (method === "GET" && cloneJobEventsMatch) {
      const jobId = cloneJobEventsMatch[1];
      const job = await getTtsJob(jobId);
      if (!job) return errorResponse("NOT_FOUND", "Job not found", requestId, 404);

      const sseHeaders = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Request-Id": requestId,
      };

      function sseMessage(event: string, data: unknown): string {
        return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      }

      // If job already terminal, send snapshot + terminal event and close
      if (job.status === "completed" || job.status === "failed") {
        const snapshot = jobSnapshot(job);
        let body = sseMessage("state", snapshot);
        if (job.status === "completed") {
          body += sseMessage("completed", { durationMs: job.durationMs, chunksTotal: job.chunksCompleted ?? 0 });
        } else {
          body += sseMessage("failed", { error: job.error });
        }
        return new Response(body, { headers: sseHeaders });
      }

      // Job is still processing — set up a live stream
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (event: string, data: unknown) => {
            try {
              controller.enqueue(encoder.encode(sseMessage(event, data)));
            } catch {
              // stream closed
            }
          };

          // Send initial state snapshot
          send("state", jobSnapshot(job));

          // Subscribe to job events
          const unsub = onJobEvent(jobId, (evt: JobEvent) => {
            send(evt.type, evt.data);
            if (evt.type === "completed" || evt.type === "failed") {
              unsub();
              clearInterval(heartbeat);
              try { controller.close(); } catch {}
            }
          });

          // Heartbeat every 30s to prevent proxy/browser timeout
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              clearInterval(heartbeat);
            }
          }, 30_000);

          // Race condition guard: re-check job status after subscribing
          getTtsJob(jobId).then((freshJob) => {
            if (!freshJob) return;
            if (freshJob.status === "completed") {
              send("completed", { durationMs: freshJob.durationMs, chunksTotal: freshJob.chunksCompleted ?? 0 });
              unsub();
              clearInterval(heartbeat);
              try { controller.close(); } catch {}
            } else if (freshJob.status === "failed") {
              send("failed", { error: freshJob.error });
              unsub();
              clearInterval(heartbeat);
              try { controller.close(); } catch {}
            } else if ((freshJob.chunksCompleted ?? 0) > (job.chunksCompleted ?? 0)) {
              // Chunks arrived between snapshot and subscribe — notify
              send("state", jobSnapshot(freshJob));
            }
          });
        },
      });

      return new Response(stream, { headers: sseHeaders });
    }

    // GET /api/clone-jobs/:jobId/chunk/:index — download individual chunk as WAV
    const cloneChunkMatch = path.match(/^\/api\/clone-jobs\/([^/]+)\/chunk\/(\d+)$/);
    if (method === "GET" && cloneChunkMatch) {
      const job = await getTtsJob(cloneChunkMatch[1]);
      if (!job) return errorResponse("NOT_FOUND", "Job not found", requestId, 404);
      const chunkIndex = parseInt(cloneChunkMatch[2], 10);
      if (job.chunksCompleted === undefined || chunkIndex >= job.chunksCompleted) {
        return errorResponse("CONFLICT", "Chunk not ready", requestId, 409);
      }
      const wav = await buildChunkWav(job.profileId, job.id, chunkIndex, 24000);
      if (!wav) return errorResponse("NOT_FOUND", "Chunk file missing", requestId, 404);
      return new Response(wav.buffer as ArrayBuffer, {
        headers: {
          "Content-Type": "audio/wav",
          "X-Request-Id": requestId,
        },
      });
    }

    // GET /api/clone-jobs/:jobId/result — download finished audio
    const cloneResultMatch = path.match(/^\/api\/clone-jobs\/([^/]+)\/result$/);
    if (method === "GET" && cloneResultMatch) {
      const job = await getTtsJob(cloneResultMatch[1]);
      if (!job) return errorResponse("NOT_FOUND", "Job not found", requestId, 404);
      if (job.status !== "completed") {
        return errorResponse("CONFLICT", "Job not ready", requestId, 409);
      }
      const audioPath = getTtsAudioPath(job.profileId, job.id);
      const file = Bun.file(audioPath);
      if (!(await file.exists())) return errorResponse("NOT_FOUND", "Result file missing", requestId, 404);
      return new Response(file, {
        headers: {
          "Content-Type": "audio/wav",
          "Content-Disposition": 'attachment; filename="clone_output.wav"',
          "X-Request-Id": requestId,
        },
      });
    }

    // GET /api/profiles/:id/tts-history — list TTS outputs for a profile
    const ttsHistoryMatch = path.match(/^\/api\/profiles\/([^/]+)\/tts-history$/);
    if (method === "GET" && ttsHistoryMatch) {
      const history = await getTtsHistory(ttsHistoryMatch[1]);
      return json(history, 200, requestId);
    }

    // GET /api/tts-audio/:profileId/:ttsId — serve archived TTS audio
    const ttsAudioMatch = path.match(/^\/api\/tts-audio\/([^/]+)\/([^/]+)$/);
    if (method === "GET" && ttsAudioMatch) {
      const audioPath = getTtsAudioPath(ttsAudioMatch[1], ttsAudioMatch[2]);
      const file = Bun.file(audioPath);
      if (!(await file.exists())) return errorResponse("NOT_FOUND", "TTS audio not found", requestId, 404);
      return new Response(file, {
        headers: { "Content-Type": "audio/wav", "X-Request-Id": requestId },
      });
    }

    // DELETE /api/tts/:ttsId — delete archived TTS entry
    const ttsDeleteMatch = path.match(/^\/api\/tts\/([^/]+)$/);
    if (method === "DELETE" && ttsDeleteMatch) {
      const ok = await deleteTtsJob(ttsDeleteMatch[1]);
      return ok ? json({ ok: true }, 200, requestId) : errorResponse("NOT_FOUND", "TTS output not found", requestId, 404);
    }

    // GET /api/tts-status
    if (method === "GET" && path === "/api/tts-status") {
      const healthy = await checkTtsHealth();
      return json({ available: healthy }, 200, requestId);
    }

    // GET /api/health — enhanced health check
    if (method === "GET" && path === "/api/health") {
      const ttsHealthy = await checkTtsHealth();
      return json(
        {
          status: "ok",
          timestamp: new Date().toISOString(),
          services: {
            bun: { status: "ok", uptime_s: Math.floor(process.uptime()) },
            tts: { backend: TTS_BACKEND, status: ttsHealthy ? "ok" : "unavailable" },
          },
        },
        200,
        requestId
      );
    }

    // GET /api/profiles/:id/recordings/:rid/embedding-status
    const embeddingStatusMatch = path.match(
      /^\/api\/profiles\/([^/]+)\/recordings\/([^/]+)\/embedding-status$/
    );
    if (method === "GET" && embeddingStatusMatch) {
      const profile = await getProfile(embeddingStatusMatch[1]);
      if (!profile) return errorResponse("NOT_FOUND", "Profile not found", requestId, 404);
      const recording = profile.recordings.find((r) => r.id === embeddingStatusMatch[2]);
      if (!recording) return errorResponse("NOT_FOUND", "Recording not found", requestId, 404);
      return json({
        status: recording.embeddingStatus,
        error: recording.embeddingError,
      }, 200, requestId);
    }

    // POST /api/profiles/:id/recordings/:rid/retry-embedding
    const retryEmbeddingMatch = path.match(
      /^\/api\/profiles\/([^/]+)\/recordings\/([^/]+)\/retry-embedding$/
    );
    if (method === "POST" && retryEmbeddingMatch) {
      const profileId = retryEmbeddingMatch[1];
      const recordingId = retryEmbeddingMatch[2];
      const profile = await getProfile(profileId);
      if (!profile) return errorResponse("NOT_FOUND", "Profile not found", requestId, 404);
      const recording = profile.recordings.find((r) => r.id === recordingId);
      if (!recording) return errorResponse("NOT_FOUND", "Recording not found", requestId, 404);

      // Fire-and-forget retry
      triggerEmbeddingExtraction(profileId, recordingId, recording.scriptText).catch(() => {});

      return json({ status: "ok", message: "Retry triggered" }, 200, requestId);
    }

    return null; // not handled
  } finally {
    logEnd();
  }
}
