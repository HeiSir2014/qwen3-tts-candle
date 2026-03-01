import type { Profile } from "../types";
import { useI18n } from "../i18n";

interface Props {
  profile: Profile;
  selected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ProfileCard({ profile, selected, onSelect, onDelete }: Props) {
  const { t } = useI18n();
  const count = profile.recordings?.length ?? profile.recordingCount ?? 0;

  return (
    <div
      className={`profile-card ${selected ? "selected" : ""}`}
      onClick={() => onSelect(profile.id)}
    >
      <button
        className="delete-btn"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(profile.id);
        }}
      >
        ✕
      </button>
      <span className="avatar">{profile.avatar}</span>
      <div className="name">{profile.name}</div>
      <div className="count">
        {count} {t("recordings_count")}
      </div>
    </div>
  );
}
