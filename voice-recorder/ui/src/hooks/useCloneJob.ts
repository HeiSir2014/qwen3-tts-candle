import { useState, useCallback, useEffect, useRef } from "react";
import * as api from "../api";

const PENDING_JOB_KEY = "voice_lab_pending_job";

/**
 * Number of decoded AudioBuffers to accumulate before starting playback.
 * The mlx backend streams ~0.8s chunks at RTF ~0.65, so 3 chunks give ~2.4s
 * of audio as margin for generation speed fluctuations (e.g. attention spikes
 * on long sequences) while adding only ~1s of start latency.
 */
const JITTER_BUFFER_SIZE = 3;

interface PendingJob {
  jobId: string;
  profileId: string;
  createdAt: string;
}

function savePendingJob(jobId: string, profileId: string) {
  localStorage.setItem(
    PENDING_JOB_KEY,
    JSON.stringify({ jobId, profileId, createdAt: new Date().toISOString() })
  );
}

function loadPendingJob(): PendingJob | null {
  try {
    const raw = localStorage.getItem(PENDING_JOB_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearPendingJob() {
  localStorage.removeItem(PENDING_JOB_KEY);
}

type CloneStatus = "idle" | "submitting" | "polling" | "completed" | "failed";

export interface CloneProgress {
  chunksCompleted: number;
  chunksTotal: number;
}

export function useCloneJob(onHistoryRefresh?: (profileId: string) => void) {
  const [status, setStatus] = useState<CloneStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resultBlobUrl, setResultBlobUrl] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [progress, setProgress] = useState<CloneProgress | null>(null);

  // ── Gapless Web Audio API playback engine ──
  const audioCtxRef = useRef<AudioContext | null>(null);
  const decodedBuffersRef = useRef<AudioBuffer[]>([]);
  const scheduledCountRef = useRef(0);       // how many buffers have been scheduled
  const nextPlayTimeRef = useRef(0);         // AudioContext time for next buffer start
  const startedRef = useRef(false);          // true once playback has begun
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const segmentTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const chunksFetchedRef = useRef(0);
  const fetchTargetRef = useRef(0);
  const fetchingRef = useRef(false);
  const generationDoneRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const sseRetryRef = useRef(0);
  const MAX_SSE_RETRIES = 5;

  // Segment tracking for dialog playback highlighting
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number | null>(null);
  const chunkToSegmentRef = useRef<number[]>([]);

  // Force re-render when chunk count changes (for progress display)
  const [, setChunkCount] = useState(0);

  /** Lazily create a shared AudioContext. */
  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    // Resume if suspended (browser autoplay policy)
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  /**
   * Core gapless scheduling: schedule all unscheduled AudioBuffers at precise
   * timestamps so they play back-to-back with no gaps.
   *
   * Uses AudioBufferSourceNode.start(time) for sample-accurate scheduling.
   * If we fall behind (stall recovery), resets the schedule from "now".
   */
  const scheduleNext = useCallback(() => {
    const buffers = decodedBuffersRef.current;

    if (!startedRef.current) {
      // Check jitter buffer threshold before starting
      const threshold = generationDoneRef.current ? 1 : JITTER_BUFFER_SIZE;
      if (buffers.length < threshold) return;

      const ctx = getAudioCtx();
      startedRef.current = true;
      nextPlayTimeRef.current = ctx.currentTime + 0.05; // tiny lead-in
    }

    const ctx = audioCtxRef.current;
    if (!ctx) return;

    // Schedule all unscheduled buffers
    while (scheduledCountRef.current < buffers.length) {
      const idx = scheduledCountRef.current;
      const buffer = buffers[idx]!;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      let startTime = nextPlayTimeRef.current;
      if (startTime < ctx.currentTime) {
        // Stall recovery: we fell behind, reset schedule from now
        startTime = ctx.currentTime + 0.02;
      }

      source.start(startTime);

      // Schedule segment highlight at the start time of this chunk
      const segIdx = chunkToSegmentRef.current[idx];
      if (segIdx !== undefined) {
        const delayMs = Math.max(0, (startTime - ctx.currentTime) * 1000);
        const timer = setTimeout(() => setActiveSegmentIndex(segIdx), delayMs);
        segmentTimersRef.current.push(timer);
      }

      // Track active sources for cleanup
      activeSourcesRef.current.push(source);
      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter(
          (s) => s !== source
        );
        // Clear segment highlight when all playback is done
        if (
          activeSourcesRef.current.length === 0 &&
          generationDoneRef.current &&
          scheduledCountRef.current >= decodedBuffersRef.current.length
        ) {
          setActiveSegmentIndex(null);
        }
      };

      nextPlayTimeRef.current = startTime + buffer.duration;
      scheduledCountRef.current++;
    }
  }, [getAudioCtx]);

  /**
   * Decode a WAV blob into an AudioBuffer and schedule it for gapless playback.
   */
  const addChunkBuffer = useCallback(
    async (wavBlob: Blob) => {
      const ctx = getAudioCtx();
      const arrayBuffer = await wavBlob.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      decodedBuffersRef.current.push(audioBuffer);
      setChunkCount((c) => c + 1);
      scheduleNext();
    },
    [getAudioCtx, scheduleNext]
  );

  const fetchChunksUpTo = useCallback(
    async (jobId: string, target: number) => {
      fetchTargetRef.current = Math.max(fetchTargetRef.current, target);

      // Mutex: only one fetch loop at a time
      if (fetchingRef.current) return;
      fetchingRef.current = true;

      try {
        while (chunksFetchedRef.current < fetchTargetRef.current) {
          const idx = chunksFetchedRef.current;
          try {
            const blob = await api.cloneJobChunkAudio(jobId, idx);
            await addChunkBuffer(blob);
            chunksFetchedRef.current = idx + 1;
          } catch {
            break; // chunk not ready, will retry on next event
          }
        }
      } finally {
        fetchingRef.current = false;
      }
    },
    [addChunkBuffer]
  );

  const closeEventSource = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  /** Stop all active AudioBufferSourceNodes and clear segment timers. */
  const teardownPlayback = useCallback(() => {
    // Stop all scheduled sources
    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    activeSourcesRef.current = [];

    // Clear segment highlight timers
    for (const timer of segmentTimersRef.current) {
      clearTimeout(timer);
    }
    segmentTimersRef.current = [];

    // Reset scheduling state
    decodedBuffersRef.current = [];
    scheduledCountRef.current = 0;
    nextPlayTimeRef.current = 0;
    startedRef.current = false;
    setActiveSegmentIndex(null);
  }, []);

  const watchJob = useCallback(
    (jobId: string, profileId: string) => {
      setStatus("polling");
      // Reset playback state
      teardownPlayback();
      chunksFetchedRef.current = 0;
      fetchTargetRef.current = 0;
      fetchingRef.current = false;
      generationDoneRef.current = false;
      chunkToSegmentRef.current = [];
      setChunkCount(0);

      closeEventSource();
      sseRetryRef.current = 0;
      const es = api.cloneJobEvents(jobId);
      esRef.current = es;

      // Initial state snapshot from server
      es.addEventListener("state", (e) => {
        const data = JSON.parse(e.data);
        if (data.chunksCompleted !== undefined) {
          setProgress({
            chunksCompleted: data.chunksCompleted,
            chunksTotal: data.chunksTotal,
          });
          fetchChunksUpTo(jobId, data.chunksCompleted);
        }
      });

      // New chunk ready
      es.addEventListener("chunk_ready", (e) => {
        const data = JSON.parse(e.data);
        if (data.segmentIndex !== undefined && data.chunkIndex !== undefined) {
          chunkToSegmentRef.current[data.chunkIndex] = data.segmentIndex;
        }
        setProgress({
          chunksCompleted: data.chunksCompleted,
          chunksTotal: data.chunksTotal,
        });
        fetchChunksUpTo(jobId, data.chunksCompleted);
      });

      // Job completed
      es.addEventListener("completed", async () => {
        closeEventSource();
        generationDoneRef.current = true;

        // If playback hasn't started, kick it (threshold drops to 1)
        if (!startedRef.current) {
          scheduleNext();
        }

        try {
          const blob = await api.cloneJobResult(jobId);
          const url = URL.createObjectURL(blob);
          setResultBlobUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });
        } catch {
          // result download failed — chunks are still available
        }
        setStatus("completed");
        setProgress(null);
        clearPendingJob();
        onHistoryRefresh?.(profileId);
      });

      // Job failed
      es.addEventListener("failed", (e) => {
        closeEventSource();
        const data = JSON.parse(e.data);
        clearPendingJob();
        setError(data.error ?? "Clone generation failed");
        setStatus("failed");
        setProgress(null);
      });

      // Connection error — fall back to single status check then reconnect
      es.onerror = () => {
        closeEventSource();
        sseRetryRef.current++;
        if (sseRetryRef.current > MAX_SSE_RETRIES) {
          clearPendingJob();
          setError("Lost connection to server. Please try again.");
          setStatus("failed");
          setProgress(null);
          return;
        }
        setTimeout(async () => {
          try {
            const res = await api.cloneJobStatus(jobId);
            if (res.status === "completed") {
              generationDoneRef.current = true;
              const blob = await api.cloneJobResult(jobId);
              const url = URL.createObjectURL(blob);
              setResultBlobUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev);
                return url;
              });
              setStatus("completed");
              setProgress(null);
              clearPendingJob();
              onHistoryRefresh?.(profileId);
            } else if (res.status === "failed") {
              clearPendingJob();
              setError(res.error ?? "Clone generation failed");
              setStatus("failed");
              setProgress(null);
            } else {
              watchJob(jobId, profileId);
            }
          } catch {
            if (sseRetryRef.current >= MAX_SSE_RETRIES) {
              clearPendingJob();
              setError("Clone job lost. Server may have restarted.");
              setStatus("failed");
              setProgress(null);
            } else {
              setTimeout(() => watchJob(jobId, profileId), 3000);
            }
          }
        }, 1000);
      };
    },
    [closeEventSource, teardownPlayback, fetchChunksUpTo, scheduleNext, onHistoryRefresh]
  );

  const submit = useCallback(
    async (
      profileId: string,
      recordingId: string,
      text: string,
      language: string
    ) => {
      setStatus("submitting");
      setError(null);
      setProgress(null);
      setResultBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });

      try {
        const { jobId } = await api.cloneSubmit(
          profileId,
          recordingId,
          text,
          language
        );
        savePendingJob(jobId, profileId);
        watchJob(jobId, profileId);
      } catch (err: any) {
        setError(err.message);
        setStatus("failed");
      }
    },
    [watchJob]
  );

  const watchExternalJob = useCallback(
    (jobId: string, profileId: string) => {
      setStatus("submitting");
      setError(null);
      setProgress(null);
      setResultBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      savePendingJob(jobId, profileId);
      watchJob(jobId, profileId);
    },
    [watchJob]
  );

  // Recover pending job on mount
  useEffect(() => {
    const pending = loadPendingJob();
    if (!pending) return;

    (async () => {
      try {
        const res = await api.cloneJobStatus(pending.jobId);
        if (!res?.status) {
          clearPendingJob();
          return;
        }
        if (res.status === "completed") {
          clearPendingJob();
          setRecovered(true);
          onHistoryRefresh?.(pending.profileId);
          return;
        }
        if (res.status === "failed") {
          clearPendingJob();
          return;
        }
        setRecovered(true);
        watchJob(pending.jobId, pending.profileId);
      } catch {
        clearPendingJob();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      closeEventSource();
      teardownPlayback();
    };
  }, [closeEventSource, teardownPlayback]);

  const reset = useCallback(() => {
    closeEventSource();
    teardownPlayback();
    chunksFetchedRef.current = 0;
    fetchTargetRef.current = 0;
    fetchingRef.current = false;
    generationDoneRef.current = false;
    chunkToSegmentRef.current = [];
    setChunkCount(0);
    setStatus("idle");
    setError(null);
    setProgress(null);
    setResultBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [closeEventSource, teardownPlayback]);

  const stopPlayback = useCallback(() => {
    teardownPlayback();
  }, [teardownPlayback]);

  const downloading = status === "submitting" || status === "polling";

  return {
    status,
    error,
    resultBlobUrl,
    recovered,
    downloading,
    progress,
    activeSegmentIndex,
    submit,
    watchExternalJob,
    reset,
    stopPlayback,
  };
}
