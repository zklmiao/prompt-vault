import Modal from "./Modal";
import { formatHotkey } from "../util";
import { useI18n } from "../i18n";
import type { Hotkeys } from "../api";

interface Props {
  hotkeys: Hotkeys;
  onClose: () => void;
}

interface Row {
  keys: string[];
  desc: string;
}

interface Group {
  title: string;
  rows: Row[];
}

/** 快捷键速查表:内容必须与真实行为一致;全局热键动态读取配置 */
export default function CheatsheetModal({ hotkeys, onClose }: Props) {
  const { t } = useI18n();
  const groups: Group[] = [
    {
      title: t("cheat.groupGlobal"),
      rows: [
        {
          keys: [formatHotkey(hotkeys.quickpick)],
          desc: t("cheat.quickpickDesc"),
        },
        {
          keys: [formatHotkey(hotkeys.clipboard_new)],
          desc: t("cheat.clipboardNewDesc"),
        },
      ],
    },
    {
      title: t("cheat.groupWindow"),
      rows: [
        { keys: ["Ctrl+N"], desc: t("cheat.newDesc") },
        { keys: ["Ctrl+F"], desc: t("cheat.focusSearch") },
        { keys: ["Ctrl+K"], desc: t("cheat.paletteDesc") },
        { keys: ["Ctrl+Enter"], desc: t("cheat.saveDesc") },
        { keys: ["?"], desc: t("cheat.sheetToggle") },
      ],
    },
    {
      title: t("cheat.groupList"),
      rows: [
        { keys: ["↑", "↓"], desc: t("cheat.upDown") },
        { keys: ["Home", "End"], desc: t("cheat.homeEnd") },
        { keys: ["Enter"], desc: t("cheat.enterCopy") },
        { keys: ["Ctrl+E"], desc: t("cheat.ctrlE") },
        { keys: ["Space"], desc: t("cheat.space") },
        { keys: ["Esc"], desc: t("cheat.escList") },
      ],
    },
    {
      title: t("cheat.groupEditorList"),
      rows: [
        { keys: ["Enter"], desc: t("cheat.tagEnter") },
        { keys: ["Enter"], desc: t("cheat.phEnter") },
        { keys: ["↑ ↓", "Enter", "Esc"], desc: t("cheat.qpKeys") },
        { keys: ["Ctrl+N"], desc: t("cheat.qpCtrlN") },
        { keys: ["Ctrl+A"], desc: t("cheat.ctrlA") },
        { keys: ["Esc"], desc: t("cheat.escModal") },
      ],
    },
  ];

  return (
    <Modal title={t("cheat.title")} onCancel={onClose}>
      <div className="cheat-sheet">
        {groups.map((group) => (
          <section key={group.title} className="cheat-group">
            <div className="cheat-title">{group.title}</div>
            {group.rows.map((row, i) => (
              <div key={`${group.title}-${i}`} className="cheat-row">
                <span className="cheat-keys">
                  {row.keys.map((key, j) => (
                    <span key={`${key}-${j}`} className="cheat-key">
                      {j > 0 && <span className="cheat-sep">/</span>}
                      <kbd className="kbd">{key}</kbd>
                    </span>
                  ))}
                </span>
                <span className="cheat-desc">{row.desc}</span>
              </div>
            ))}
          </section>
        ))}
        <p className="modal-hint" style={{ marginTop: 14 }}>
          {t("cheat.footerHint")}
        </p>
      </div>
    </Modal>
  );
}
