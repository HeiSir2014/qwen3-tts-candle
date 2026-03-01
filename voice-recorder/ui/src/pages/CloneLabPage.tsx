import type { Profile } from "../types";
import { useI18n } from "../i18n";
import { CloneLab } from "../components/CloneLab";

interface Props {
  profiles: Profile[];
}

export function CloneLabPage({ profiles }: Props) {
  const { t } = useI18n();

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t("clone_title")}</h1>
        <p className="page-subtitle">{t("subtitle")}</p>
      </div>

      <CloneLab profiles={profiles} />
    </>
  );
}
