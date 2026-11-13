import { IconImport } from "./icons";
import { useI18n } from "../i18n";

/** 拖拽悬停时的全屏提示;不拦截鼠标事件 */
export default function DropOverlay({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  if (!visible) return null;
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-card">
        <IconImport size={30} />
        <div className="drop-title">{t("drop.title")}</div>
        <div className="drop-hint">{t("drop.hint")}</div>
      </div>
    </div>
  );
}
