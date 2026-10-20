import { join } from "path";
import { networkInterfaces } from "os";
import { handleApi, triggerEmbeddingExtraction } from "./routes";
import { startTtsServer, stopTtsServer } from "./tts-bridge";
import { getProfiles, cleanupStaleJobs, getEmbeddingPath } from "./store";
import { createLogger } from "./logger";

const log = createLogger("server");
const PORT = 3000;

function getLanIp(): string {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return "127.0.0.1";
}
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const CERTS_DIR = join(import.meta.dir, "..", "certs");

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 255, // max allowed — TTS generation can take 30s+
  tls: {
    cert: Bun.file(join(CERTS_DIR, "cert.pem")),
    key: Bun.file(join(CERTS_DIR, "key.pem")),
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Extract client IP
    const socketAddress = server.requestIP(req);
    const clientIp = socketAddress?.address || "unknown";

    // CORS headers for mobile access
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Request-Id",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // API routes
    if (path.startsWith("/api/")) {
      try {
        const response = await handleApi(req, path, clientIp);
        if (response) {
          for (const [k, v] of Object.entries(corsHeaders)) {
            response.headers.set(k, v);
          }
          return response;
        }
      } catch (err: any) {
        log.error("Unhandled API error", { error: err.message, path });
        return new Response(
          JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // Static files
    let filePath = path === "/" ? "/index.html" : path;
    const file = Bun.file(join(PUBLIC_DIR, filePath));
    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not Found", { status: 404 });
  },
});

const lanIp = getLanIp();
log.info("Server started", { port: PORT, protocol: "https" });
log.info(`Local: https://localhost:${PORT}`);
log.info(`Network: https://${lanIp}:${PORT}  <-- use this on mobile/iPad`);

// Clean up stale "processing" jobs from previous server runs
cleanupStaleJobs().then((n) => {
  if (n > 0) log.info(`Cleaned up ${n} stale processing job(s) from previous run`);
}).catch(() => {});

// Start TTS server in background, then process pending embeddings sequentially.
// "ready" recordings are redone when the current backend's prompt file is
// missing (e.g. after switching TTS_BACKEND), since the formats differ.
startTtsServer()
  .then(async () => {
    try {
      const profiles = await getProfiles();
      const pending: { profileId: string; recordingId: string; scriptText: string }[] = [];
      for (const profile of profiles) {
        for (const recording of profile.recordings) {
          const missingPrompt = recording.embeddingStatus === "ready"
            && !(await Bun.file(getEmbeddingPath(profile.id, recording.id)).exists());
          if (recording.embeddingStatus === "pending" || recording.embeddingStatus === "processing" || missingPrompt) {
            pending.push({ profileId: profile.id, recordingId: recording.id, scriptText: recording.scriptText });
          }
        }
      }
      if (pending.length > 0) {
        log.info(`Processing ${pending.length} pending embedding(s) sequentially...`);
        for (const { profileId, recordingId, scriptText } of pending) {
          try {
            await triggerEmbeddingExtraction(profileId, recordingId, scriptText);
          } catch {}
        }
        log.info("Startup embedding extraction complete");
      }
    } catch (err: any) {
      log.error("Failed to scan recordings for pending embeddings", { error: err.message });
    }
  })
  .catch((err: any) => {
    log.error("Failed to start TTS server", { error: err.message });
    log.error("Voice clone features will not be available.");
  });

// Graceful shutdown — covers normal exit, bun --watch restarts, and crashes
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Shutting down (${signal})...`);
  await stopTtsServer();
  server.stop();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("beforeExit", () => shutdown("beforeExit"));
