import { useEffect } from "react";
import type { Profile, Script } from "../types";
import { useI18n } from "../i18n";
import { useRouter, Link } from "../router";
import { RecordingStudio } from "../components/RecordingStudio";

interface Props {
  profiles: Profile[];
  scripts: Script[];
  onRefresh: () => Promise<void>;
}

export function StudioPage({ profiles, scripts, onRefresh }: Props) {
  const { t } = useI18n();
  const { path, navigate } = useRouter();

  // Extract profileId from /studio/:id
  const parts = path.split("/").filter(Boolean);
  const profileId = parts[1] ?? "";
  const profile = profiles.find((p) => p.id === profileId);

  useEffect(() => {
    if (profiles.length > 0 && !profile) {
      navigate("/");
    }
  }, [profiles, profile, navigate]);

  if (!profile) {
    return (
      <div className="section-empty">{t("select_profile_first")}</div>
    );
  }

  return (
    <>
      <div className="page-header">
        <Link to="/" className="back-link">
          ← {t("nav_profiles")}
        </Link>
        <div className="page-header-row">
          <div>
            <h1 className="page-title">
              {profile.avatar} {profile.name}
            </h1>
            <p className="page-subtitle">{t("studio_title")}</p>
          </div>
        </div>
      </div>

      <RecordingStudio
        profile={profile}
        scripts={scripts}
        onRefresh={onRefresh}
      />
    </>
  );
}
