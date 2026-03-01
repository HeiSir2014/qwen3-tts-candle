import type { Recording } from "../../types";
import { useI18n } from "../../i18n";
import { EmbeddingBadge } from "../ui/Badge";

interface Props {
  recordings: Recording[];
  profileId: string;
  onPlay: (profileId: string, recordingId: string) => void;
  onDelete: (profileId: string, recordingId: string) => void;
  onRetryEmbedding: (profileId: string, recordingId: string) => void;
}

export function RecordingList({
  recordings,
  profileId,
  onPlay,
  onDelete,
  onRetryEmbedding,
}: Props) {
  const { t } = useI18n();

  if (!recordings.length) {
    return <div className="section-empty">{t("no_recordings")}</div>;
  }

  return (
    <div className="recording-list">
      {recordings.map((r) => {
        const preview = r.scriptText
          ? r.scriptText.substring(0, 60) +
            (r.scriptText.length > 60 ? "..." : "")
          : "(no text)";
        const date = new Date(r.createdAt).toLocaleString();
        const es = r.embeddingStatus || "pending";
        const showRetry = es === "failed" || es === "pending";

        return (
          <div key={r.id} className="recording-item">
            <button
              className="play-btn"
              onClick={() => onPlay(profileId, r.id)}
            >
              ▶
            </button>
            <div className="info">
              <div className="script-preview">{preview}</div>
              <div className="date">{date}</div>
            </div>
            <EmbeddingBadge
              status={es}
              label={t(`embedding_${es}` as any)}
            />
            {showRetry && (
              <button
                className="retry-btn"
                onClick={() => onRetryEmbedding(profileId, r.id)}
              >
                ↻
              </button>
            )}
            <button
              className="del-btn"
              onClick={() => onDelete(profileId, r.id)}
            >
              🗑
            </button>
          </div>
        );
      })}
    </div>
  );
}
