import { useEffect, useState } from "react";
import Modal from "./Modal";
import { getHotkeys, setHotkeys } from "../api";
import { isComposingEvent, formatHotkey } from "../util";
import { useI18n } from "../i18n";

interface Props {
  onClose: () => void;
  showToast: (text: string, kind?: "ok" | "err") => void;
}

const DEFAULTS = { quickpick: "alt+q", clipboard_new: "alt+shift+n" };

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "CapsLock"]);

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
  const { t } = useI18n();
  const [capturing, setCapturing] = useState(false);

  return (
    <div className="hotkey-row">
      <span className="hotkey-label">{label}</span>
      <input
        className={"hotkey-input" + (capturing ? " capturing" : "")}
        value={capturing ? t("settings.capture") : formatHotkey(value)}
        readOnly
        onClick={() => {
          setCapturing(true);
          onError(null);
        }}
        onBlur={() => setCapturing(false)}
        onKeyDown={(e) => {
          // 输入法组字期间不录制,避免把选字按键当成快捷键
          if (isComposingEvent(e)) return;
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
            onError(t("settings.badKey"));
            return;
          }
          const mods = modifiersOf(e);
          if (mods.length === 0) {
            onError(t("settings.needModifier"));
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

/** 界面语言选项:跟随系统 / 内置两种 / 检测到的语言包码(去重,展示语言码原文) */
function LanguageRow() {
  const { t, langPref, setLang, providedLangs } = useI18n();
  return (
    <div className="hotkey-row">
      <span className="hotkey-label">{t("settings.langSection")}</span>
      <select
        className="settings-lang-select"
        value={langPref}
        onChange={(e) => setLang(e.target.value)}
        aria-label={t("settings.langSection")}
      >
        <option value="auto">{t("settings.langAuto")}</option>
        <option value="zh-CN">{t("settings.langZh")}</option>
        <option value="en">{t("settings.langEn")}</option>
        {providedLangs
          .filter((code) => code !== "zh-CN" && code !== "en")
          .map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
      </select>
    </div>
  );
}

export default function SettingsModal({ onClose, showToast }: Props) {
  const { t } = useI18n();
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
      setError(t("settings.browserNotice"));
      return;
    }
    if (qp === cn) {
      setError(t("settings.sameKeys"));
      return;
    }
    setSaving(true);
    try {
      await setHotkeys(qp, cn);
      setQuickpick(qp);
      setClipboardNew(cn);
      showToast(t("settings.toastSaved"));
    } catch (e) {
      setError(String(e) || t("settings.saveFailed"));
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
    <Modal title={t("settings.title")} onCancel={onClose}>
      <p className="modal-hint">{t("settings.hint")}</p>
      {!available && (
        <div className="settings-error">{t("settings.browserNotice")}</div>
      )}

      <div className="settings-section">
        <div className="settings-heading">{t("settings.hotkeysSection")}</div>
        <HotkeyField
          label={t("settings.quickpick")}
          value={quickpick}
          onChange={setQuickpick}
          onError={setError}
        />
        <HotkeyField
          label={t("settings.clipboardNew")}
          value={clipboardNew}
          onChange={setClipboardNew}
          onError={setError}
        />
        <div className="hotkey-tip">{t("settings.hotkeyTip")}</div>
      </div>

      {/* 语言行不依赖 Tauri:浏览器预览(热键区 available=false)下也必须可用 */}
      <div className="settings-section">
        <LanguageRow />
      </div>

      {loading && <div className="settings-note">{t("settings.readingConfig")}</div>}
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-actions">
        <button
          className="btn"
          onClick={restoreDefaults}
          disabled={!available || saving || loading}
        >
          {t("settings.restoreDefaults")}
        </button>
        <div className="settings-actions-right">
          <button className="btn" onClick={onClose}>
            {t("settings.close")}
          </button>
          <button
            className="btn primary"
            onClick={() => void save(quickpick, clipboardNew)}
            disabled={!available || saving || loading}
          >
            {saving ? t("settings.saving") : t("settings.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
