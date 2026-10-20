import { useState, useCallback, useRef, useEffect } from "react";
import type { Profile, Script } from "../../types";
import { useI18n } from "../../i18n";
import { useRecorder } from "../../hooks/useRecorder";
import { useToast } from "../Toast";
import * as api from "../../api";
import { ScriptSelector } from "./ScriptSelector";
import { RecordingControls } from "./RecordingControls";
import { RecordingList } from "./RecordingList";

interface Props {
  profile: Profile;
  scripts: Script[];
  onRefresh: () => Promise<void>;
}

const MAX_EMBEDDING_POLLS = 60; // 60 × 3s = 3 min max

export function RecordingStudio({ profile, scripts, onRefresh }: Props) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const recorder = useRecorder();
  const embeddingPollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (embeddingPollRef.current) clearInterval(embeddingPollRef.current);
    };
  }, []);

  const [phase, setPhase] = useState<"select" | "record">("select");
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [scriptText, setScriptText] = useState("");

  const handleScriptSelect = useCallback(
    (scriptId: string | null, text: string) => {
      setSelectedScriptId(scriptId);
      setScriptText(text);
      setPhase("record");
    },
    []
  );

  const backToSelect = useCallback(() => {
    setPhase("select");
    setSelectedScriptId(null);
    setScriptText("");
  }, []);

  const toggleRecord = useCallback(async () => {
    if (recorder.isRecording) {
      recorder.stop();
    } else {
      try {
        await recorder.start();
      } catch {
        showToast("Microphone access denied");
      }
    }
  }, [recorder, showToast]);

  const playPreview = useCallback(() => {
    if (!recorder.recordingBlob) return;
    const audio = new Audio(URL.createObjectURL(recorder.recordingBlob));
    audio.play();
  }, [recorder.recordingBlob]);

  const saveRecording = useCallback(async () => {
    if (!recorder.recordingBlob) return;
    try {
      const recording = await api.uploadRecording(
        profile.id,
        recorder.recordingBlob,
        selectedScriptId,
        scriptText
      );
      showToast(t("recording_saved"));
      recorder.discard();
      backToSelect();
      await onRefresh();

      if (recording?.id) {
        if (embeddingPollRef.current) clearInterval(embeddingPollRef.current);
        let attempts = 0;
        embeddingPollRef.current = setInterval(async () => {
          attempts++;
          try {
            const res = await api.embeddingStatus(profile.id, recording.id);
            if (res.status === "ready" || res.status === "failed" || attempts >= MAX_EMBEDDING_POLLS) {
              clearInterval(embeddingPollRef.current);
              embeddingPollRef.current = undefined;
              await onRefresh();
            }
          } catch {
            clearInterval(embeddingPollRef.current);
            embeddingPollRef.current = undefined;
          }
        }, 3000);
      }
    } catch (err: any) {
      showToast("Upload failed: " + err.message);
    }
  }, [
    recorder,
    profile.id,
    selectedScriptId,
    scriptText,
    showToast,
    t,
    backToSelect,
    onRefresh,
  ]);

  const playRecording = useCallback(
    (profileId: string, recordingId: string) => {
      const audio = new Audio(api.audioUrl(profileId, recordingId));
      audio.play();
    },
    []
  );

  const deleteRecording = useCallback(
    async (profileId: string, recordingId: string) => {
      if (!confirm(t("confirm_delete_recording"))) return;
      await api.deleteRecording(profileId, recordingId);
      showToast(t("recording_deleted"));
      await onRefresh();
    },
    [t, showToast, onRefresh]
  );

  const retryEmbedding = useCallback(
    async (profileId: string, recordingId: string) => {
      await api.retryEmbedding(profileId, recordingId);
      if (embeddingPollRef.current) clearInterval(embeddingPollRef.current);
      let attempts = 0;
      embeddingPollRef.current = setInterval(async () => {
        attempts++;
        try {
          const res = await api.embeddingStatus(profileId, recordingId);
          if (res.status === "ready" || res.status === "failed" || attempts >= MAX_EMBEDDING_POLLS) {
            clearInterval(embeddingPollRef.current);
            embeddingPollRef.current = undefined;
            await onRefresh();
          }
        } catch {
          clearInterval(embeddingPollRef.current);
          embeddingPollRef.current = undefined;
        }
      }, 3000);
    },
    [onRefresh]
  );

  return (
    <>
      <div className="card">
        {phase === "select" ? (
          <ScriptSelector scripts={scripts} onSelect={handleScriptSelect} />
        ) : (
          <>
            <div className="selected-script-banner">
              <div className="selected-script-text">
                {scriptText}
              </div>
              <button className="change-script-btn" onClick={backToSelect}>
                {t("change_script")}
              </button>
            </div>

            <RecordingControls
              isRecording={recorder.isRecording}
              duration={recorder.duration}
              mediaStream={recorder.mediaStream}
              recordingBlob={recorder.recordingBlob}
              onToggleRecord={toggleRecord}
              onPlayPreview={playPreview}
              onDiscard={recorder.discard}
              onSave={saveRecording}
            />
          </>
        )}
      </div>

      <div className="card">
        <div className="card-title">
          <span className="icon">📁</span>
          {t("recordings_title")}
        </div>
        <RecordingList
          recordings={profile.recordings || []}
          profileId={profile.id}
          onPlay={playRecording}
          onDelete={deleteRecording}
          onRetryEmbedding={retryEmbedding}
        />
      </div>
    </>
  );
}
