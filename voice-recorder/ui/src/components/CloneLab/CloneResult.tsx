import { useI18n } from "../../i18n";
import type { CloneProgress } from "../../hooks/useCloneJob";

interface Props {
  status: "idle" | "submitting" | "polling" | "completed" | "failed";
  error: string | null;
  resultBlobUrl: string | null;
  progress: CloneProgress | null;
}

export function CloneResult({ status, error, resultBlobUrl, progress }: Props) {
  const { t } = useI18n();

  if (status === "submitting") {
    return (
      <div className="clone-status-area">
        <div className="spinner" />
        <span>{t("generating")}</span>
      </div>
    );
  }

  if (status === "polling") {
    const hasChunks = progress && progress.chunksCompleted > 0;
    return (
      <div className="clone-status-area">
        <div className="spinner" />
        <span>
          {t("generating")}
          {hasChunks && ` — ${progress.chunksCompleted} chunks`}
        </span>
        {hasChunks && <div className="clone-progress-bar" />}
      </div>
    );
  }

  if (status === "failed" && error) {
    return (
      <div className="clone-result error">
        <p style={{ fontWeight: 600, color: "var(--color-destructive)" }}>
          {t("clone_error")}
        </p>
        <p style={{ marginTop: 4, fontSize: "0.9rem", color: "var(--color-muted-foreground)" }}>
          {error}
        </p>
      </div>
    );
  }

  if (status === "completed" && resultBlobUrl) {
    const download = () => {
      const a = document.createElement("a");
      a.href = resultBlobUrl;
      a.download = "voice_clone_output.wav";
      a.click();
    };

    return (
      <div className="clone-result success">
        <p style={{ fontWeight: 600, marginBottom: 8 }}>{t("result_title")}</p>
        <div className="result-actions">
          <button className="btn btn-secondary btn-sm" onClick={download}>
            {t("download")}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
