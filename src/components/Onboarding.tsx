import { useEffect, useState } from "react";
import { getHotkeys } from "../api";
import { formatHotkey } from "../util";

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
      <h2 className="onboard-title">欢迎使用 Prompt Vault</h2>
      <p className="onboard-sub muted">三步上手:收集、填空、随叫随到。</p>

      <div className="onboard-grid">
        <div className="onboard-card">
          <div className="onboard-step">1</div>
          <h3>收集</h3>
          <p className="muted">
            把你觉得好用的 prompt 存进收藏,支持标签、置顶与全字段搜索。
          </p>
          <button className="btn primary" onClick={onCreateFirst}>
            新建第一条
          </button>
        </div>

        <div className="onboard-card">
          <div className="onboard-step">2</div>
          <h3>试占位符</h3>
          <p className="muted">
            正文里写 {"{{变量}}"},复制前会弹窗填空,同名变量只填一次。
          </p>
          <button className="btn" onClick={onCreateSample}>
            创建示例
          </button>
        </div>

        <div className="onboard-card">
          <div className="onboard-step">3</div>
          <h3>随叫随到</h3>
          <p className="muted">
            按 <kbd className="kbd">{hotkey}</kbd> 可在任意界面唤起快速拾取,
            输入几个字,Enter 直接复制。
          </p>
        </div>
      </div>

      <div className="onboard-foot">
        <button className="link-btn" onClick={onSkip}>
          跳过引导
        </button>
      </div>
    </div>
  );
}
