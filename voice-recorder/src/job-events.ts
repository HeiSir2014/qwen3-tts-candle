import { EventEmitter } from "events";

export interface JobEvent {
  type: "chunk_ready" | "completed" | "failed";
  jobId: string;
  data: Record<string, unknown>;
}

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emitJobEvent(event: JobEvent): void {
  bus.emit(`job:${event.jobId}`, event);
}

/** Subscribe to events for a specific job. Returns an unsubscribe function. */
export function onJobEvent(
  jobId: string,
  listener: (event: JobEvent) => void
): () => void {
  const channel = `job:${jobId}`;
  bus.on(channel, listener);
  return () => {
    bus.removeListener(channel, listener);
  };
}
