import { createLogger, startTimer } from "./logger";

const log = createLogger("middleware");

// ── Request ID ──

export function generateRequestId(): string {
  return crypto.randomUUID();
}

// ── Rate Limiting ──

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_CLONE_MAX = 5;

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(key);
    }
  }
}, 300_000);

export function checkRateLimit(
  ip: string,
  isClone: boolean
): { allowed: boolean; retryAfterMs?: number } {
  const key = isClone ? `clone:${ip}` : `general:${ip}`;
  const limit = isClone ? RATE_LIMIT_CLONE_MAX : RATE_LIMIT_MAX_REQUESTS;
  const now = Date.now();

  let entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateLimitMap.set(key, entry);
  }

  entry.count++;
  if (entry.count > limit) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - entry.windowStart);
    return { allowed: false, retryAfterMs };
  }
  return { allowed: true };
}

// ── Input Validation ──

export function sanitizeString(input: string, maxLength: number = 10000): string {
  if (typeof input !== "string") return "";
  return input.trim().slice(0, maxLength);
}

export function validateUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ── Structured Error Response ──

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export function errorResponse(
  code: string,
  message: string,
  requestId: string,
  status: number
): Response {
  const body: ApiErrorBody = {
    error: { code, message, requestId },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
  });
}

// ── Request Logging ──

export function logRequest(
  requestId: string,
  method: string,
  path: string,
  ip: string
): () => void {
  const elapsed = startTimer();
  log.info("request_start", { requestId, method, path, ip });
  return () => {
    log.info("request_end", { requestId, method, path, duration_ms: elapsed() });
  };
}
