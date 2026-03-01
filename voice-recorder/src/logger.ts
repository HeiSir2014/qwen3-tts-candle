import winston from "winston";
import { join } from "path";
import { mkdirSync } from "fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOGS_DIR = join(import.meta.dir, "..", "logs");
mkdirSync(LOGS_DIR, { recursive: true });

// Format: "2026-02-15 13:29:45.123 INFO  [component] message key=value key2=value2"
const traditionalFormat = winston.format.printf((info) => {
  const { timestamp, level, component, message, ...rest } = info;
  const lvl = level.toUpperCase().padEnd(5);
  const keys = Object.keys(rest).filter((k) => k !== "splat");
  const extras =
    keys.length > 0
      ? " " +
        keys
          .map((k) => {
            const v = rest[k];
            if (typeof v === "string" && v.includes(" ")) return `${k}="${v}"`;
            return `${k}=${v}`;
          })
          .join(" ")
      : "";
  return `${timestamp} ${lvl} [${component}] ${message}${extras}`;
});

const baseLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    traditionalFormat
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ level: true }),
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
        traditionalFormat
      ),
    }),
    new winston.transports.File({
      filename: join(LOGS_DIR, "bun.log"),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

export function setLogLevel(level: LogLevel): void {
  baseLogger.level = level;
}

export function createLogger(component: string) {
  const child = baseLogger.child({ component });
  return {
    debug: (msg: string, extra?: Record<string, unknown>) =>
      child.debug({ message: msg, ...extra }),
    info: (msg: string, extra?: Record<string, unknown>) =>
      child.info({ message: msg, ...extra }),
    warn: (msg: string, extra?: Record<string, unknown>) =>
      child.warn({ message: msg, ...extra }),
    error: (msg: string, extra?: Record<string, unknown>) =>
      child.error({ message: msg, ...extra }),
    flush: async () => {},
  };
}

/** Returns a function that, when called, returns elapsed milliseconds since startTimer() was called. */
export function startTimer(): () => number {
  const start = performance.now();
  return () => Math.round((performance.now() - start) * 100) / 100;
}
