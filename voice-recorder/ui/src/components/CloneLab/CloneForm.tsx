import { useState, useEffect, useCallback, useMemo } from "react";
import { SYSTEM_PROFILE_ID, type Profile, type SystemProfile } from "../../types";
import { useI18n } from "../../i18n";
import * as api from "../../api";
import { DialogEditor } from "./DialogEditor";

type Mode = "single" | "dialog";

interface ProfileMapping {
  [speakerName: string]: { profileId: string; recordingId: string };
}

interface Props {
  profiles: Profile[];
  disabled: boolean;
  onSubmit: (
    profileId: string,
    recordingId: string,
    text: string,
    language: string
  ) => void;
  onDialogSubmit: (
    text: string,
    language: string,
    profileMapping: ProfileMapping
  ) => void;
  onSystemSubmit: (voice: string, text: string, language: string) => void;
  onProfileChange: (profileId: string | null) => void;
  activeSegmentIndex: number | null;
}

/**
 * Pick the best recording for a profile: prefer "ready" embedding, then first available.
 */
function pickBestRecording(profile: Profile): string | null {
  const ready = profile.recordings.find((r) => r.embeddingStatus === "ready");
  if (ready) return ready.id;
  return profile.recordings[0]?.id ?? null;
}

export function CloneForm({
  profiles,
  disabled,
  onSubmit,
  onDialogSubmit,
  onSystemSubmit,
  onProfileChange,
  activeSegmentIndex,
}: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("single");
  const [profileId, setProfileId] = useState("");
  const [recordingId, setRecordingId] = useState("");
  const [singleText, setSingleText] = useState("");
  const [dialogText, setDialogText] = useState("");
  const [language, setLanguage] = useState("Auto");

  // Dialog mode state — speaker names extracted from Tiptap content
  const [speakerNames, setSpeakerNames] = useState<string[]>([]);

  // Preset voices; empty when the TTS backend has no CustomVoice model
  const [systemProfiles, setSystemProfiles] = useState<SystemProfile[]>([]);
  useEffect(() => {
    api.getSystemProfiles().then(setSystemProfiles, () => {});
  }, []);

  const systemVoice = systemProfiles.find((v) => v.id === profileId);
  const profile = profiles.find((p) => p.id === profileId);
  const recordings = profile?.recordings ?? [];

  // Auto-resolve speaker names to profiles by matching profile.name
  const autoMapping = useMemo(() => {
    const mapping: ProfileMapping = {};
    for (const name of speakerNames) {
      const matched = profiles.find((p) => p.name === name);
      if (matched) {
        const rid = pickBestRecording(matched);
        if (rid) mapping[name] = { profileId: matched.id, recordingId: rid };
      }
    }
    return mapping;
  }, [speakerNames, profiles]);

  // Detect unmatched speaker names
  const unmatchedNames = useMemo(
    () => speakerNames.filter((name) => !autoMapping[name]),
    [speakerNames, autoMapping]
  );

  // Auto-select if only one profile (single mode)
  useEffect(() => {
    if (mode === "single" && profiles.length === 1 && !profileId) {
      setProfileId(profiles[0]!.id);
      onProfileChange(profiles[0]!.id);
    }
  }, [profiles, profileId, onProfileChange, mode]);

  // Auto-select if only one recording
  useEffect(() => {
    if (recordings.length === 1 && !recordingId) {
      setRecordingId(recordings[0]!.id);
    }
  }, [recordings, recordingId]);

  const handleProfileChange = (id: string) => {
    setProfileId(id);
    setRecordingId("");
    const isSystem = systemProfiles.some((v) => v.id === id);
    onProfileChange(isSystem ? SYSTEM_PROFILE_ID : id || null);
  };

  const handleSubmit = () => {
    if (mode === "single") {
      if (systemVoice) {
        if (!singleText.trim()) return;
        onSystemSubmit(systemVoice.id, singleText.trim(), language);
        return;
      }
      if (!profileId || !recordingId || !singleText.trim()) return;
      onSubmit(profileId, recordingId, singleText.trim(), language);
    } else {
      if (!dialogText.trim() || speakerNames.length === 0 || unmatchedNames.length > 0) return;
      onDialogSubmit(dialogText.trim(), language, autoMapping);
    }
  };

  const handleDialogContentChange = useCallback(
    (newText: string, names: string[]) => {
      setDialogText(newText);
      setSpeakerNames(names);
    },
    []
  );

  const singleValid = systemVoice
    ? !!singleText.trim()
    : !!(profileId && recordingId && singleText.trim());
  const dialogValid = !!(dialogText.trim() && speakerNames.length > 0 && unmatchedNames.length === 0);
  const canSubmit = !disabled && (mode === "single" ? singleValid : dialogValid);

  const embeddingIcon = (es: string) =>
    ({ pending: "⏳", processing: "⚙️", ready: "✓", failed: "✗" }[es] ?? "⏳");

  return (
    <div className="clone-form">
      {/* Mode switcher */}
      <div className="clone-mode-tabs">
        <button
          className={`clone-mode-tab ${mode === "single" ? "active" : ""}`}
          onClick={() => setMode("single")}
        >
          {t("single_mode")}
        </button>
        <button
          className={`clone-mode-tab ${mode === "dialog" ? "active" : ""}`}
          onClick={() => setMode("dialog")}
        >
          {t("dialog_mode")}
        </button>
      </div>

      {/* Single mode: profile & recording selectors */}
      {mode === "single" && (
        <>
          <div className="form-group">
            <label>{t("clone_profile")}</label>
            <select
              value={profileId}
              onChange={(e) => handleProfileChange(e.target.value)}
            >
              <option value="">{t("select_profile")}</option>
              {systemProfiles.length > 0 && (
                <optgroup label={t("system_voices_group")}>
                  {systemProfiles.map((v) => (
                    <option key={v.id} value={v.id}>
                      [{t("system_voice_badge")}] {v.name} — {v.description}
                    </option>
                  ))}
                </optgroup>
              )}
              {profiles.length > 0 && (
                <optgroup label={t("user_profiles_group")}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.avatar} {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {!systemVoice && (
            <div className="form-group">
              <label>{t("clone_recording")}</label>
              <select
                value={recordingId}
                onChange={(e) => setRecordingId(e.target.value)}
              >
                <option value="">{t("select_recording")}</option>
                {recordings.map((r) => {
                  const label = r.scriptText
                    ? r.scriptText.substring(0, 50) + "..."
                    : r.id.substring(0, 8);
                  return (
                    <option key={r.id} value={r.id}>
                      [{embeddingIcon(r.embeddingStatus || "pending")}] {label}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
        </>
      )}

      {/* Text input */}
      <div className="form-group">
        <label>{t("clone_text")}</label>
        {mode === "dialog" ? (
          <DialogEditor
            onContentChange={handleDialogContentChange}
            activeSegmentIndex={activeSegmentIndex}
            disabled={disabled}
            placeholder={t("dialog_text_placeholder")}
          />
        ) : (
          <textarea
            value={singleText}
            onChange={(e) => setSingleText(e.target.value)}
            placeholder={t("clone_text_placeholder")}
          />
        )}
      </div>

      {/* Dialog mode: auto-resolved speaker status */}
      {mode === "dialog" && speakerNames.length > 0 && (
        <div className="form-group">
          <div className="dialog-speaker-status">
            {speakerNames.map((name) => {
              const mapped = !!autoMapping[name];
              return (
                <span
                  key={name}
                  className={`dialog-speaker-chip ${mapped ? "matched" : "unmatched"}`}
                >
                  {mapped ? "✓" : "✗"} {name}
                </span>
              );
            })}
          </div>
          {unmatchedNames.length > 0 && (
            <div className="dialog-unmatched-hint">
              {t("unmatched_speakers")}: {unmatchedNames.join(", ")}
            </div>
          )}
        </div>
      )}

      {/* Language selector */}
      <div className="form-group">
        <label>{t("clone_language")}</label>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="Auto">Auto</option>
          <option value="Chinese">Chinese / 中文</option>
          <option value="English">English</option>
          <option value="Japanese">Japanese / 日本語</option>
          <option value="Korean">Korean / 한국어</option>
        </select>
      </div>

      <button
        className="btn btn-primary"
        disabled={!canSubmit}
        onClick={handleSubmit}
      >
        {t("generate")}
      </button>
    </div>
  );
}
