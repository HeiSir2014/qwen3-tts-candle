import { useState, useCallback, useEffect, useRef } from "react";
import * as api from "../api";

const PENDING_JOB_KEY = "voice_lab_pending_job";

/** Number of chunks to buffer before starting playback. */
const JITTER_BUFFER_SIZE = 1;

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

  // ── Chunk playback engine (ref-based to avoid stale closures) ──
  const chunkUrlsRef = useRef<string[]>([]);
  const chunksFetchedRef = useRef(0);
  const fetchTargetRef = useRef(0);   // highest chunk target requested
  const fetchingRef = useRef(false);  // mutex: true while fetch loop is running
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playingIndexRef = useRef(-1); // -1 = not started
  const stalledRef = useRef(false);   // true = waiting for next chunk
  const generationDoneRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const sseRetryRef = useRef(0);
  const MAX_SSE_RETRIES = 5;

  // Segment tracking for playback highlighting
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number | null>(null);
  const chunkToSegmentRef = useRef<number[]>([]);

  // Force re-render when chunk count changes (for progress display)
  const [, setChunkCount] = useState(0);

  /**
   * Core scheduling function: play the next available chunk or stall.
   * Called from both onended and when new chunks arrive.
   */
  const scheduleNext = useCallback(() => {
    const urls = chunkUrlsRef.current;
    const nextIdx = playingIndexRef.current;

    if (nextIdx < 0) {
      // Not started yet — check if we have enough buffered
      const threshold = generationDoneRef.current ? 1 : JITTER_BUFFER_SIZE;
      if (urls.length >= threshold) {
        playingIndexRef.current = 0;
        stalledRef.current = false;
        const url = urls[0]!;
        const segIdx = chunkToSegmentRef.current[0];
        if (segIdx !== undefined) setActiveSegmentIndex(segIdx);
        const audio = audioRef.current || new Audio();
        audioRef.current = audio;
        audio.src = url;
        audio.onended = () => {
          playingIndexRef.current++;
          scheduleNext();
        };
        audio.play().catch(() => {});
      }
      return;
    }

    if (nextIdx < urls.length) {
      // Next chunk is ready — play it
      stalledRef.current = false;
      const url = urls[nextIdx]!;
      const segIdx = chunkToSegmentRef.current[nextIdx];
      if (segIdx !== undefined) setActiveSegmentIndex(segIdx);
      const audio = audioRef.current || new Audio();
      audioRef.current = audio;
      audio.src = url;
      audio.onended = () => {
        playingIndexRef.current++;
        scheduleNext();
      };
      audio.play().catch(() => {});
    } else if (generationDoneRef.current) {
      // All chunks played, generation done — finished
      stalledRef.current = false;
      setActiveSegmentIndex(null);
    } else {
      // Stalled: RTF > 1, waiting for next chunk
      stalledRef.current = true;
    }
  }, []);

  const addChunkUrl = useCallback(
    (url: string) => {
      chunkUrlsRef.current = [...chunkUrlsRef.current, url];
      setChunkCount((c) => c + 1);
      // If stalled or not started, try to resume/start
      if (stalledRef.current || playingIndexRef.current < 0) {
        scheduleNext();
      }
    },
    [scheduleNext]
  );

  const fetchChunksUpTo = useCallback(
    async (jobId: string, target: number) => {
      // Update target (may grow while a fetch loop is already running)
      fetchTargetRef.current = Math.max(fetchTargetRef.current, target);

      // Mutex: only one fetch loop at a time. Concurrent callers just
      // bump the target above — the running loop will pick it up.
      if (fetchingRef.current) return;
      fetchingRef.current = true;

      try {
        while (chunksFetchedRef.current < fetchTargetRef.current) {
          const idx = chunksFetchedRef.current;
          try {
            const blob = await api.cloneJobChunkAudio(jobId, idx);
            const url = URL.createObjectURL(blob);
            addChunkUrl(url);
            chunksFetchedRef.current = idx + 1;
          } catch {
            break; // chunk not ready, will retry on next event
          }
        }
      } finally {
        fetchingRef.current = false;
      }
    },
    [addChunkUrl]
  );

  const closeEventSource = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const watchJob = useCallback(
    (jobId: string, profileId: string) => {
      setStatus("polling");
      // Reset playback state
      chunkUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      chunkUrlsRef.current = [];
      chunksFetchedRef.current = 0;
      fetchTargetRef.current = 0;
      fetchingRef.current = false;
      playingIndexRef.current = -1;
      stalledRef.current = false;
      generationDoneRef.current = false;
      chunkToSegmentRef.current = [];
      setActiveSegmentIndex(null);
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

        // If playback hasn't started or is stalled, kick it
        if (playingIndexRef.current < 0 || stalledRef.current) {
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

      // Connection error — fall back to single status check then reconnect (with retry limit)
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
            // Job not found or server error — give up after retries
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
    [closeEventSource, fetchChunksUpTo, scheduleNext, onHistoryRefresh]
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
    return () => closeEventSource();
  }, [closeEventSource]);

  const reset = useCallback(() => {
    closeEventSource();
    setStatus("idle");
    setError(null);
    setProgress(null);
    setActiveSegmentIndex(null);
    chunkToSegmentRef.current = [];
    stalledRef.current = false;
    generationDoneRef.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    playingIndexRef.current = -1;
    chunkUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    chunkUrlsRef.current = [];
    setChunkCount(0);
    setResultBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [closeEventSource]);

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    playingIndexRef.current = -1;
    stalledRef.current = false;
    setActiveSegmentIndex(null);
  }, []);

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
