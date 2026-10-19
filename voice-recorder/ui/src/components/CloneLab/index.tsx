import { useState, useEffect, useCallback } from "react";
import { SYSTEM_PROFILE_ID, type Profile } from "../../types";
import { useI18n } from "../../i18n";
import { useCloneJob } from "../../hooks/useCloneJob";
import { useTtsHistory } from "../../hooks/useTtsHistory";
import { useToast } from "../Toast";
import * as api from "../../api";
import { CloneForm } from "./CloneForm";
import { CloneResult } from "./CloneResult";
import { TtsHistory } from "./TtsHistory";

interface Props {
  profiles: Profile[];
}

export function CloneLab({ profiles }: Props) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const ttsHistory = useTtsHistory();

  const historyRefresh = useCallback(
    (profileId: string) => {
      ttsHistory.refresh(profileId);
    },
    [ttsHistory]
  );

  const cloneJob = useCloneJob(historyRefresh);

  const [ttsOnline, setTtsOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const s = await api.ttsStatus();
        setTtsOnline(s.available);
      } catch {
        setTtsOnline(false);
      }
    };
    check();
    const iv = setInterval(check, 15000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (cloneJob.recovered) {
      showToast(t("tts_recovered"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneJob.recovered]);

  const handleProfileChange = useCallback(
    (profileId: string | null) => {
      ttsHistory.load(profileId);
    },
    [ttsHistory]
  );

  const handleSubmit = useCallback(
    async (
      profileId: string,
      recordingId: string,
      text: string,
      language: string
    ) => {
      const profile = profiles.find((p) => p.id === profileId);
      const rec = profile?.recordings.find((r) => r.id === recordingId);
      if (rec && rec.embeddingStatus !== "ready") {
        showToast(t("embedding_slow_warning"));
      }
      await cloneJob.submit(profileId, recordingId, text, language);
    },
    [profiles, cloneJob, showToast, t]
  );

  const handleDialogSubmit = useCallback(
    async (
      text: string,
      language: string,
      profileMapping: Record<string, { profileId: string; recordingId: string }>
    ) => {
      try {
        const { jobId } = await api.cloneDialogSubmit(text, language, profileMapping);
        // Use first profile's ID for SSE watching and history refresh
        const firstMapping = Object.values(profileMapping)[0]!;
        cloneJob.watchExternalJob(jobId, firstMapping.profileId);
      } catch (err: any) {
        showToast(err.message);
      }
    },
    [cloneJob, showToast]
  );

  const handleSystemSubmit = useCallback(
    async (voice: string, text: string, language: string) => {
      try {
        const { jobId } = await api.ttsSubmit(voice, text, language);
        cloneJob.watchExternalJob(jobId, SYSTEM_PROFILE_ID);
      } catch (err: any) {
        showToast(err.message);
      }
    },
    [cloneJob, showToast]
  );

  return (
    <>
      <div className="card">
        <div className="card-title">
          <span className="icon">🧬</span>
          {t("clone_title")}
          <span className="right">
            <span className="status-indicator">
              <span
                className={`status-dot ${ttsOnline === true ? "online" : ttsOnline === false ? "offline" : ""}`}
              />
              {ttsOnline === null
                ? "Checking..."
                : ttsOnline
                  ? t("tts_online")
                  : t("tts_offline")}
            </span>
          </span>
        </div>

        <CloneForm
          profiles={profiles}
          disabled={cloneJob.downloading}
          onSubmit={handleSubmit}
          onDialogSubmit={handleDialogSubmit}
          onSystemSubmit={handleSystemSubmit}
          onProfileChange={handleProfileChange}
          activeSegmentIndex={cloneJob.activeSegmentIndex}
        />

        <CloneResult
          status={cloneJob.status}
          error={cloneJob.error}
          resultBlobUrl={cloneJob.resultBlobUrl}
          progress={cloneJob.progress}
        />
      </div>

      {ttsHistory.history.length > 0 && (
        <div className="card">
          <div className="card-title">
            <span className="icon">📜</span>
            {t("tts_history_title")}
          </div>
          <TtsHistory
            history={ttsHistory.history}
            onDelete={ttsHistory.remove}
            onPlayStart={cloneJob.stopPlayback}
          />
        </div>
      )}
    </>
  );
}
