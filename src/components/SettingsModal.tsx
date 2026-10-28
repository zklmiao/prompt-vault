import { useEffect, useState } from "react";
import Modal from "./Modal";
import { getHotkeys, setHotkeys } from "../api";

interface Props {
  onClose: () => void;
  showToast: (text: string, kind?: "ok" | "err") => void;
}

const DEFAULTS = { quickpick: "alt+q", clipboard_new: "alt+shift+n" };

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "CapsLock"]);

/** "alt+shift+n" → "Alt+Shift+N";也用于展示配置里手写的大写形式 */
function displayOf(hotkey: string): string {
  return hotkey
    .split("+")
    .map((part) => {
      const p = part.trim().toLowerCase();
      if (p === "alt") return "Alt";
      if (p === "ctrl" || p === "control" || p === "commandorcontrol") return "Ctrl";
      if (p === "shift") return "Shift";
      if (p === "super" || p === "win" || p === "meta") return "Win";
      if (p === "space") return "Space";
      if (p === "arrowup") return "↑";
      if (p === "arrowdown") return "↓";
      if (p === "arrowleft") return "←";
      if (p === "arrowright") return "→";
      if (/^f\d{1,2}$/.test(p)) return p.toUpperCase();
      return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join("+");
}

function modifiersOf(e: React.KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("super");
  return mods;
}

/**
 * 只产出 Rust 端 Shortcut 解析器已验证支持的主键形态
 * (字母 / 数字 / F1-F24 / Space / 方向键,均带修饰键;单元测试见 lib.rs)
 */
function keyToken(e: React.KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return e.key.toLowerCase();
  if (e.key === " " || e.code === "Space") return "space";
  if (e.key === "ArrowUp") return "arrowup";
  if (e.key === "ArrowDown") return "arrowdown";
  if (e.key === "ArrowLeft") return "arrowleft";
  if (e.key === "ArrowRight") return "arrowright";
  return null;
}

function HotkeyField({
  label,
  value,
  onChange,
  onError,
}: {
  label: string;
  value: string;
  onChange: (hotkey: string) => void;
  onError: (error: string | null) => void;
}) {
  const [capturing, setCapturing] = useState(false);

  return (
    <div className="hotkey-row">
      <span className="hotkey-label">{label}</span>
      <input
        className={"hotkey-input" + (capturing ? " capturing" : "")}
        value={capturing ? "按下组合键…" : displayOf(value)}
        readOnly
        onClick={() => {
          setCapturing(true);
          onError(null);
        }}
        onBlur={() => setCapturing(false)}
        onKeyDown={(e) => {
          // 未在录制时放行 Tab 等默认行为
          if (!capturing) {
            if (e.key === "Tab") return;
            setCapturing(true);
          }
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Tab") {
            setCapturing(false);
            return;
          }
          if (e.key === "Escape") {
            setCapturing(false);
            e.currentTarget.blur();
            onError(null);
            return;
          }
          if (MODIFIER_KEYS.has(e.key)) {
            // 只有修饰键:继续等待主键
            onError(null);
            return;
          }
          const token = keyToken(e);
          if (!token) {
            onError("不支持的按键,请用字母 / 数字 / F1-F24 / Space / 方向键");
            return;
          }
          const mods = modifiersOf(e);
          if (mods.length === 0) {
            onError("请包含至少一个修饰键(Ctrl / Alt / Shift / Win)");
            return;
          }
          onChange([...mods, token].join("+"));
          onError(null);
          setCapturing(false);
        }}
      />
    </div>
  );
}

export default function SettingsModal({ onClose, showToast }: Props) {
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [quickpick, setQuickpick] = useState(DEFAULTS.quickpick);
  const [clipboardNew, setClipboardNew] = useState(DEFAULTS.clipboard_new);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const hotkeys = await getHotkeys();
        if (disposed) return;
        setQuickpick(hotkeys.quickpick || DEFAULTS.quickpick);
        setClipboardNew(hotkeys.clipboard_new || DEFAULTS.clipboard_new);
        setAvailable(true);
      } catch {
        // 浏览器预览等无 Tauri 运行时的环境
        if (!disposed) setAvailable(false);
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const save = async (qp: string, cn: string) => {
    setError(null);
    if (!available) {
      setError("当前环境(浏览器预览)不支持修改热键,请在打包版中使用。");
      return;
    }
    if (qp === cn) {
      setError("两个功能不能使用同一组合键");
      return;
    }
    setSaving(true);
    try {
      await setHotkeys(qp, cn);
      setQuickpick(qp);
      setClipboardNew(cn);
      showToast("热键已更新,立即生效");
    } catch (e) {
      setError(String(e) || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const restoreDefaults = () => {
    setQuickpick(DEFAULTS.quickpick);
    setClipboardNew(DEFAULTS.clipboard_new);
    void save(DEFAULTS.quickpick, DEFAULTS.clipboard_new);
  };

  return (
    <Modal title="设置" onCancel={onClose}>
      <p className="modal-hint">
        全局热键在任意应用中都生效;修改后立即生效,无需重启。
      </p>
      {!available && (
        <div className="settings-error">
          当前环境(浏览器预览)不支持修改热键,请在打包版中使用。
        </div>
      )}

      <div className="settings-section">
        <div className="settings-heading">全局快捷键</div>
        <HotkeyField
          label="快速拾取"
          value={quickpick}
          onChange={setQuickpick}
          onError={setError}
        />
        <HotkeyField
          label="剪贴板新建"
          value={clipboardNew}
          onChange={setClipboardNew}
          onError={setError}
        />
        <div className="hotkey-tip">
          点击输入框后按下组合键录制;必须包含 Ctrl / Alt / Shift / Win;Esc
          取消录制。
        </div>
      </div>

      {loading && <div className="settings-note">读取当前配置…</div>}
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-actions">
        <button
          className="btn"
          onClick={restoreDefaults}
          disabled={!available || saving || loading}
        >
          恢复默认
        </button>
        <div className="settings-actions-right">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="btn primary"
            onClick={() => void save(quickpick, clipboardNew)}
            disabled={!available || saving || loading}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
