import { useState } from "react";
import { Modal } from "./ui/Modal";
import { useI18n } from "../i18n";

const EMOJIS = [
  "🎤", "🎵", "🎸", "🎹", "🎺", "🎻", "🎼", "👤",
  "👩", "👨", "🧑", "👶", "🤖", "🦊", "🐱", "🌟",
];

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, avatar: string) => void;
}

export function CreateProfileModal({ open, onClose, onCreate }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🎤");

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, emoji);
    setName("");
    setEmoji("🎤");
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose}>
      <h3>{t("new_profile")}</h3>
      <label>{t("profile_name_label")}</label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("name_placeholder")}
        onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        autoFocus
      />
      <label>{t("avatar_label")}</label>
      <div className="emoji-picker">
        {EMOJIS.map((e) => (
          <button
            key={e}
            className={e === emoji ? "selected" : ""}
            onClick={() => setEmoji(e)}
          >
            {e}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="btn btn-primary" onClick={handleCreate}>
          {t("create")}
        </button>
      </div>
    </Modal>
  );
}
