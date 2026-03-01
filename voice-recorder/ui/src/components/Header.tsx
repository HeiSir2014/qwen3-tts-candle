import { useI18n } from "../i18n";

export function Header() {
  const { lang, setLang, t } = useI18n();

  return (
    <header>
      <h1>{t("title")}</h1>
      <p>{t("subtitle")}</p>
      <div className="lang-toggle">
        <button
          className={lang === "en" ? "active" : ""}
          onClick={() => setLang("en")}
        >
          EN
        </button>
        <button
          className={lang === "zh" ? "active" : ""}
          onClick={() => setLang("zh")}
        >
          中文
        </button>
      </div>
    </header>
  );
}
