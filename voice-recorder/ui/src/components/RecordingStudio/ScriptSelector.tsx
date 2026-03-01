import { useState } from "react";
import type { Script } from "../../types";
import { useI18n } from "../../i18n";

interface Props {
  scripts: Script[];
  onSelect: (scriptId: string | null, text: string) => void;
}

type Filter = "all" | "zh" | "en" | "custom";

export function ScriptSelector({ scripts, onSelect }: Props) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");
  const [customText, setCustomText] = useState("");

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: t("filter_all") },
    { key: "zh", label: "中文" },
    { key: "en", label: "English" },
    { key: "custom", label: t("filter_custom") },
  ];

  const filtered =
    filter === "all"
      ? scripts
      : filter === "custom"
        ? []
        : scripts.filter((s) => s.language === filter);

  return (
    <div>
      <div className="script-filter">
        {filters.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? "active" : ""}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filter === "custom" ? (
        <div className="custom-script">
          <textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder={t("custom_placeholder")}
          />
          <button
            className="btn btn-primary"
            style={{ marginTop: 10, width: "100%" }}
            onClick={() => {
              const text = customText.trim();
              if (text) onSelect(null, text);
            }}
          >
            {t("start_recording")}
          </button>
        </div>
      ) : (
        <div className="script-list">
          {filtered.length ? (
            filtered.map((s) => (
              <div
                key={s.id}
                className="script-item"
                onClick={() => onSelect(s.id, s.text)}
              >
                <div className="category">{s.category}</div>
                <div className="text">{s.text}</div>
              </div>
            ))
          ) : (
            <div className="section-empty">{t("select_script_hint")}</div>
          )}
        </div>
      )}
    </div>
  );
}
