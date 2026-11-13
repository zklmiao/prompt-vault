import { useEffect, useState } from "react";
import { getHotkeys } from "../api";
import { formatHotkey } from "../util";
import { useI18n } from "../i18n";

export interface OnboardingProps {
  onSkip: () => void;
  onCreateFirst: () => void;
  onCreateSample: () => void;
}

/** 首次启动的三步引导卡片(空态时显示,可跳过) */
export default function Onboarding({
  onSkip,
  onCreateFirst,
  onCreateSample,
}: OnboardingProps) {
  const { t } = useI18n();
  const [hotkey, setHotkey] = useState("Alt+Q");

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const h = await getHotkeys();
        if (!disposed) setHotkey(formatHotkey(h.quickpick || "alt+q"));
      } catch {
        /* 浏览器预览等无 Tauri 环境:保持默认展示 */
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <div className="onboard">
      <h2 className="onboard-title">{t("onboard.title")}</h2>
      <p className="onboard-sub muted">{t("onboard.subtitle")}</p>

      <div className="onboard-grid">
        <div className="onboard-card">
          <div className="onboard-step">1</div>
          <h3>{t("onboard.step1Title")}</h3>
          <p className="muted">{t("onboard.step1Desc")}</p>
          <button className="btn primary" onClick={onCreateFirst}>
            {t("onboard.createFirst")}
          </button>
        </div>

        <div className="onboard-card">
          <div className="onboard-step">2</div>
          <h3>{t("onboard.step2Title")}</h3>
          <p className="muted">{t("onboard.step2Desc")}</p>
          <button className="btn" onClick={onCreateSample}>
            {t("onboard.createSample")}
          </button>
        </div>

        <div className="onboard-card">
          <div className="onboard-step">3</div>
          <h3>{t("onboard.step3Title")}</h3>
          <p className="muted">
            {t("onboard.step3Prefix")} <kbd className="kbd">{hotkey}</kbd>{" "}
            {t("onboard.step3Suffix")}
          </p>
        </div>
      </div>

      <div className="onboard-foot">
        <button className="link-btn" onClick={onSkip}>
          {t("onboard.skip")}
        </button>
      </div>
    </div>
  );
}
