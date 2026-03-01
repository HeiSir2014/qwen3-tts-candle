export function EmbeddingBadge({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  const icons: Record<string, string> = {
    pending: "⏳",
    processing: "⚙️",
    ready: "✓",
    failed: "✗",
  };
  return (
    <span className={`embedding-badge ${status}`}>
      {icons[status]} {label}
    </span>
  );
}

export function TtsStatusBadge({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  return (
    <span className={`tts-status-badge ${status}`}>
      {label}
    </span>
  );
}
