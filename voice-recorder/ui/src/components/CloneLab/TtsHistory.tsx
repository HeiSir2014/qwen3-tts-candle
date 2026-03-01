import { useRef, useState } from "react";
import type { TtsJob } from "../../types";
import { useI18n } from "../../i18n";
import { TtsStatusBadge } from "../ui/Badge";
import * as api from "../../api";

interface Props {
  history: TtsJob[];
  onDelete: (ttsId: string) => void;
  onPlayStart?: () => void;
}

export function TtsHistory({ history, onDelete, onPlayStart }: Props) {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  if (!history.length) {
    return <div className="section-empty">{t("tts_history_empty")}</div>;
  }

  const play = (job: TtsJob) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    onPlayStart?.();

    const audio = new Audio(api.ttsAudioUrl(job.profileId, job.id));
    audioRef.current = audio;
    setPlayingId(job.id);

    audio.onended = () => {
      setPlayingId(null);
      audioRef.current = null;
    };
    audio.onerror = () => {
      setPlayingId(null);
      audioRef.current = null;
    };
    audio.play().catch(() => {
      setPlayingId(null);
    });
  };

  const stop = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    setPlayingId(null);
  };

  const download = (job: TtsJob) => {
    const a = document.createElement("a");
    a.href = api.ttsAudioUrl(job.profileId, job.id);
    a.download = `clone_${job.id.substring(0, 8)}.wav`;
    a.click();
  };

  const handleDelete = (job: TtsJob) => {
    if (!confirm(t("confirm_delete_tts"))) return;
    onDelete(job.id);
  };

  return (
    <div className="tts-history-list">
      {history.map((job) => {
        const preview = job.text
          ? job.text.substring(0, 60) + (job.text.length > 60 ? "..." : "")
          : "";
        const date = new Date(job.createdAt).toLocaleString();
        const statusText = t(`tts_history_${job.status}` as any);
        const durationInfo = job.durationMs
          ? `${t("tts_duration_label")}: ${(job.durationMs / 1000).toFixed(1)}s`
          : "";
        const isThisPlaying = playingId === job.id;
        const isDialog = job.mode === "dialog";

        // Audio duration & RTF
        const audioDurInfo = job.audioDurationS
          ? `${t("audio_duration")}: ${job.audioDurationS.toFixed(1)}s`
          : "";
        const rtfInfo =
          job.audioDurationS && job.durationMs
            ? `${t("rtf_label")}: ${(job.durationMs / 1000 / job.audioDurationS).toFixed(2)}`
            : "";

        // Dialog profile names
        const dialogProfiles = isDialog && job.dialogSegments
          ? [...new Set(job.dialogSegments.map((s) => s.profileName))].join(", ")
          : "";

        return (
          <div key={job.id} className="tts-history-item">
            <div className="tts-info">
              <div className="tts-text-preview">
                {isDialog && <span className="dialog-badge">{t("dialog_badge")}</span>}{" "}
                {preview}
              </div>
              <div className="tts-meta">
                <span>{date}</span>
                <span>{job.language || "Auto"}</span>
                {durationInfo && <span>{durationInfo}</span>}
              </div>
              {(audioDurInfo || rtfInfo) && (
                <div className="tts-meta-extra">
                  {audioDurInfo && <span>{audioDurInfo}</span>}
                  {rtfInfo && <span>{rtfInfo}</span>}
                </div>
              )}
              {dialogProfiles && (
                <div className="tts-dialog-profiles">{dialogProfiles}</div>
              )}
            </div>
            <TtsStatusBadge status={job.status} label={statusText} />
            <div className="tts-actions">
              {job.status === "completed" && (
                <>
                  <button onClick={() => (isThisPlaying ? stop() : play(job))}>
                    {isThisPlaying ? "⏹" : "▶"}
                  </button>
                  <button onClick={() => download(job)}>⬇</button>
                </>
              )}
              {(job.status === "completed" || job.status === "failed") && (
                <button
                  className="tts-del-btn"
                  onClick={() => handleDelete(job)}
                >
                  🗑
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
