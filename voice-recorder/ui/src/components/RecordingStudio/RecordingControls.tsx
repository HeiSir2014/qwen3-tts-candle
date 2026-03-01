import { useI18n } from "../../i18n";
import { AudioWaveform } from "../AudioWaveform";

interface Props {
  isRecording: boolean;
  duration: number;
  mediaStream: MediaStream | null;
  recordingBlob: Blob | null;
  onToggleRecord: () => void;
  onPlayPreview: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function RecordingControls({
  isRecording,
  duration,
  mediaStream,
  recordingBlob,
  onToggleRecord,
  onPlayPreview,
  onDiscard,
  onSave,
}: Props) {
  const { t } = useI18n();

  return (
    <div className="record-section">
      {/* Waveform */}
      <div className="waveform-container">
        {mediaStream && (
          <AudioWaveform
            stream={mediaStream}
            barCount={32}
            barWidth={4}
            barGap={3}
            barMaxHeight={56}
            barColor="var(--color-active)"
          />
        )}
      </div>

      {/* Timer */}
      <div className={`record-timer ${isRecording ? "active" : ""}`}>
        {formatTime(duration)}
      </div>

      {/* Record button */}
      <button
        className={`record-btn ${isRecording ? "recording" : ""}`}
        onClick={onToggleRecord}
      >
        <div className="inner" />
      </button>

      <div className="record-hint">
        {isRecording ? t("stop") : t("record_hint")}
      </div>

      {/* Preview controls */}
      {recordingBlob && !isRecording && (
        <div className="preview-controls">
          <button className="btn btn-secondary btn-sm" onClick={onPlayPreview}>
            {t("play")}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={onDiscard}>
            {t("discard")}
          </button>
          <button className="btn btn-primary btn-sm" onClick={onSave}>
            {t("save_upload")}
          </button>
        </div>
      )}
    </div>
  );
}
