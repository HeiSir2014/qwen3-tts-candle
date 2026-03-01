import { spawn, type Subprocess, $ } from "bun";
import { join } from "path";
import { createLogger, startTimer } from "./logger";

const log = createLogger("rust-bridge");

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const TTS_BINARY = join(PROJECT_ROOT, "target", "release", "tts-server");
const TTS_PORT = 5001;
const TTS_URL = `http://127.0.0.1:${TTS_PORT}`;

let ttsProcess: Subprocess | null = null;
let intentionalKill = false;
let restartCount = 0;
const MAX_RESTART_DELAY_MS = 60_000;

/**
 * Kill any process listening on TTS_PORT.
 * Prevents zombie processes from blocking startup.
 */
async function killExistingOnPort(port: number): Promise<void> {
  try {
    const result = await $`lsof -ti :${port}`.text();
    const pids = result.trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      const pidNum = parseInt(pid, 10);
      if (!isNaN(pidNum)) {
        log.warn(`Killing orphaned process on port ${port}`, { pid: pidNum });
        process.kill(pidNum, "SIGKILL");
      }
    }
    if (pids.length > 0) {
      await Bun.sleep(500);
    }
  } catch {
    // No process on port — nothing to do
  }
}

function watchProcess(proc: Subprocess) {
  proc.exited.then((code) => {
    if (intentionalKill) return;
    ttsProcess = null;
    restartCount++;
    const delay = Math.min(2000 * Math.pow(2, restartCount - 1), MAX_RESTART_DELAY_MS);
    log.warn(`TTS server exited unexpectedly (code=${code}), restarting in ${delay}ms... (attempt ${restartCount})`);
    setTimeout(() => {
      startTtsServer().catch((err: any) => {
        log.error("Failed to restart TTS server", { error: err.message });
      });
    }, delay);
  });
}

export async function startTtsServer(): Promise<void> {
  log.info("Starting Rust TTS server...");
  intentionalKill = false;

  // Kill any orphaned process still holding the port
  await killExistingOnPort(TTS_PORT);

  ttsProcess = spawn({
    cmd: [TTS_BINARY, "--port", String(TTS_PORT)],
    stdout: "inherit",
    stderr: "inherit",
  });

  watchProcess(ttsProcess);

  // Wait for the server to be ready (model loading can take 60s+)
  const maxRetries = 120;
  for (let i = 0; i < maxRetries; i++) {
    if (!ttsProcess) return;
    try {
      const res = await fetch(`${TTS_URL}/health`);
      if (res.ok) {
        restartCount = 0;
        log.info("Rust TTS server is ready!");
        return;
      }
    } catch {
      // not ready yet
    }
    await Bun.sleep(1000);
  }
  log.warn("Rust TTS server did not become ready in time. Clone features may not work.");
}

export async function stopTtsServer(): Promise<void> {
  intentionalKill = true;
  if (ttsProcess) {
    ttsProcess.kill();
    ttsProcess = null;
    log.info("Rust TTS server stopped.");
  }
}

export async function checkTtsHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${TTS_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function requestExtractEmbedding(
  body: {
    ref_audio_path: string;
    ref_text: string;
    output_path: string;
  },
  requestId?: string
): Promise<{ status: string; output_path: string }> {
  const elapsed = startTimer();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (requestId) headers["X-Request-Id"] = requestId;

  log.info("extract_embedding_start", { requestId });

  let res: Response;
  try {
    res = await fetch(`${TTS_URL}/extract-embedding`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
  } catch (err: any) {
    log.error("extract_embedding_failed", { requestId, error: err.message });
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error("Embedding extraction timed out.");
    }
    throw new Error(`TTS server connection failed: ${err.message}`);
  }
  if (!res.ok) {
    let errMsg: string;
    try {
      const errJson = await res.json();
      errMsg = errJson.error || `TTS server error (${res.status})`;
    } catch {
      errMsg = `TTS server error (${res.status})`;
    }
    log.error("extract_embedding_error", { requestId, status: res.status, error: errMsg });
    throw new Error(errMsg);
  }

  log.info("extract_embedding_complete", { requestId, duration_ms: elapsed() });
  return res.json();
}

export interface CloneResult {
  wavBuffer: ArrayBuffer;
  bridgeDurationMs: number;
}

export async function requestClone(
  body: {
    ref_audio_path: string;
    ref_text: string;
    text: string;
    language: string;
    embedding_path?: string;
  },
  requestId?: string
): Promise<CloneResult> {
  const elapsed = startTimer();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (requestId) headers["X-Request-Id"] = requestId;

  log.info("clone_request_start", { requestId, text_length: body.text.length });

  // Use the streaming endpoint and collect all chunks
  let res: Response;
  try {
    res = await fetch(`${TTS_URL}/clone-stream`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
  } catch (err: any) {
    log.error("clone_request_failed", { requestId, error: err.message });
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error("Generation timed out. Try shorter text or a different reference audio.");
    }
    throw new Error(`TTS server connection failed: ${err.message}`);
  }

  if (!res.ok) {
    let errMsg: string;
    try {
      const errJson = await res.json();
      errMsg = errJson.error || `TTS server error (${res.status})`;
    } catch {
      errMsg = `TTS server error (${res.status})`;
    }
    log.error("clone_request_error", { requestId, status: res.status, error: errMsg });
    throw new Error(errMsg);
  }

  const wavBuffer = await res.arrayBuffer();
  const bridgeDurationMs = elapsed();

  log.info("clone_request_complete", {
    requestId,
    bridgeDurationMs,
    wav_bytes: wavBuffer.byteLength,
  });

  return { wavBuffer, bridgeDurationMs };
}

// ── Streaming clone ──

export interface CloneStreamChunk {
  chunkIndex: number;
  totalChunks: number;
  sampleRate: number;
  pcmData: Uint8Array; // int16 LE
}

export async function* requestCloneStream(
  body: {
    ref_audio_path: string;
    ref_text: string;
    text: string;
    language: string;
    embedding_path?: string;
  },
  requestId?: string
): AsyncGenerator<CloneStreamChunk, void, undefined> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (requestId) headers["X-Request-Id"] = requestId;

  log.info("clone_stream_start", {
    requestId,
    text_length: body.text.length,
    has_embedding: !!body.embedding_path,
    has_ref_text: !!body.ref_text?.trim(),
  });

  const streamStartTime = Date.now();

  let res: Response;
  try {
    res = await fetch(`${TTS_URL}/clone-stream`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    log.error("clone_stream_connection_failed", {
      requestId,
      error: err.message,
      elapsed_ms: Date.now() - streamStartTime,
    });
    throw new Error(`TTS server connection failed: ${err.message}`);
  }

  if (!res.ok) {
    let errMsg: string;
    try {
      const errJson = (await res.json()) as { error?: string };
      errMsg = errJson.error || `TTS server error (${res.status})`;
    } catch {
      errMsg = `TTS server error (${res.status})`;
    }
    log.error("clone_stream_http_error", {
      requestId,
      status: res.status,
      error: errMsg,
      elapsed_ms: Date.now() - streamStartTime,
    });
    throw new Error(errMsg);
  }

  log.info("clone_stream_response_ok", {
    requestId,
    status: res.status,
    elapsed_ms: Date.now() - streamStartTime,
  });

  const reader = res.body!.getReader();
  let buffer = new Uint8Array(0);
  const HEADER_SIZE = 16; // 4 x uint32 BE
  let totalBytesReceived = 0;
  let chunksYielded = 0;
  let firstChunkTime: number | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      totalBytesReceived += value.length;
      // Append to buffer
      const newBuf = new Uint8Array(buffer.length + value.length);
      newBuf.set(buffer);
      newBuf.set(value, buffer.length);
      buffer = newBuf;
    }

    // Parse complete frames from buffer
    while (buffer.length >= HEADER_SIZE) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const chunkIndex = view.getUint32(0);
      const totalChunks = view.getUint32(4);
      const sampleRate = view.getUint32(8);
      const dataLength = view.getUint32(12);

      const frameSize = HEADER_SIZE + dataLength;
      if (buffer.length < frameSize) break; // need more data

      if (chunkIndex === 0xffffffff) {
        // Error frame
        const errorMsg = new TextDecoder().decode(buffer.slice(HEADER_SIZE, frameSize));
        log.error("clone_stream_remote_error", {
          requestId,
          error: errorMsg,
          chunks_received_before_error: chunksYielded,
          elapsed_ms: Date.now() - streamStartTime,
        });
        throw new Error(errorMsg);
      }

      if (chunkIndex === 0xfffffffd) {
        // End frame: totalChunks field contains actual total count
        const totalMs = Date.now() - streamStartTime;
        log.info("clone_stream_end_frame", {
          requestId,
          actual_total: totalChunks,
          chunks_yielded: chunksYielded,
          total_bytes_received: totalBytesReceived,
          total_ms: totalMs,
          ttfb_ms: firstChunkTime ? firstChunkTime - streamStartTime : null,
        });
        buffer = buffer.slice(frameSize);
        reader.cancel();
        return;
      }

      // Skip non-audio frames (processing status, chunk ready, etc.)
      // Audio frames have marker MARKER_AUDIO (0xFFFFFFFE) at offset 4.
      if (totalChunks !== 0xfffffffe) {
        buffer = buffer.slice(frameSize);
        continue;
      }

      const pcmData = buffer.slice(HEADER_SIZE, frameSize);

      if (firstChunkTime === null) {
        firstChunkTime = Date.now();
        log.info("clone_stream_first_chunk", {
          requestId,
          chunkIndex,
          pcm_bytes: pcmData.byteLength,
          sample_rate: sampleRate,
          ttfb_ms: firstChunkTime - streamStartTime,
        });
      }

      yield { chunkIndex, totalChunks, sampleRate, pcmData };
      chunksYielded++;

      log.info("clone_stream_chunk", {
        requestId,
        chunkIndex,
        pcm_bytes: pcmData.byteLength,
        elapsed_ms: Date.now() - streamStartTime,
      });

      buffer = buffer.slice(frameSize);
    }

    if (done) break;
  }

  // Stream ended without end frame (unexpected)
  log.warn("clone_stream_ended_without_end_frame", {
    requestId,
    chunks_yielded: chunksYielded,
    remaining_buffer_bytes: buffer.length,
    total_bytes_received: totalBytesReceived,
    elapsed_ms: Date.now() - streamStartTime,
  });
}
