import { useState, useCallback } from "react";
import type { Profile } from "../types";
import { useI18n } from "../i18n";
import { useRouter } from "../router";
import { useToast } from "../components/Toast";
import { ProfileCard } from "../components/ProfileCard";
import { CreateProfileModal } from "../components/CreateProfileModal";

interface Props {
  profiles: Profile[];
  onCreateProfile: (name: string, avatar: string) => Promise<void>;
  onDeleteProfile: (id: string) => Promise<void>;
}

export function ProfilesPage({
  profiles,
  onCreateProfile,
  onDeleteProfile,
}: Props) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const { showToast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);

  const handleCreate = useCallback(
    async (name: string, avatar: string) => {
      await onCreateProfile(name, avatar);
      showToast(t("profile_created"));
      setModalOpen(false);
    },
    [onCreateProfile, showToast, t]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm(t("confirm_delete_profile"))) return;
      await onDeleteProfile(id);
      showToast(t("profile_deleted"));
    },
    [onDeleteProfile, showToast, t]
  );

  const handleSelect = useCallback(
    (id: string) => {
      navigate(`/studio/${id}`);
    },
    [navigate]
  );

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">{t("profiles_title")}</h1>
            <p className="page-subtitle">{t("subtitle")}</p>
          </div>
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
            {t("add_new")}
          </button>
        </div>
      </div>

      <div className="profile-grid">
        {profiles.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            selected={false}
            onSelect={handleSelect}
            onDelete={handleDelete}
          />
        ))}
        <div
          className="add-profile-card"
          onClick={() => setModalOpen(true)}
        >
          <span className="plus">+</span>
          <div className="name" style={{ color: "var(--color-muted-foreground)" }}>
            {t("add_new")}
          </div>
        </div>
      </div>

      <CreateProfileModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={handleCreate}
      />
    </>
  );
}
