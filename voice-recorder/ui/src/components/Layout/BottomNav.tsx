import { useI18n } from "../../i18n";
import { useToast } from "../Toast";
import { NavItem } from "./NavItem";

interface Props {
  lastProfileId: string | null;
}

export function BottomNav({ lastProfileId }: Props) {
  const { t, lang, setLang } = useI18n();
  const { showToast } = useToast();

  const studioPath = lastProfileId ? `/studio/${lastProfileId}` : null;

  const handleDisabledClick = () => {
    showToast(t("select_profile_first"));
  };

  return (
    <nav className="bottom-nav">
      <NavItem to="/" icon="🏠" label={t("nav_profiles")} />
      {studioPath ? (
        <NavItem
          to={studioPath}
          icon="🎙"
          label={t("nav_studio")}
          matchPattern="/studio/:id"
        />
      ) : (
        <NavItem
          to="/"
          icon="🎙"
          label={t("nav_studio")}
          disabled
          onDisabledClick={handleDisabledClick}
        />
      )}
      <NavItem to="/clone" icon="🧬" label={t("nav_clone")} />
      <button
        className="nav-item"
        onClick={() => setLang(lang === "en" ? "zh" : "en")}
      >
        <span className="nav-icon">🌐</span>
        <span className="nav-label">{lang === "en" ? "中文" : "EN"}</span>
      </button>
    </nav>
  );
}
