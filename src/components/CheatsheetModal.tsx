import Modal from "./Modal";
import { formatHotkey } from "../util";
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
  const groups: Group[] = [
    {
      title: "全局",
      rows: [
        {
          keys: [formatHotkey(hotkeys.quickpick)],
          desc: "唤出 / 收起快速拾取面板",
        },
        {
          keys: [formatHotkey(hotkeys.clipboard_new)],
          desc: "把剪贴板内容存为新收藏",
        },
      ],
    },
    {
      title: "窗口",
      rows: [
        { keys: ["Ctrl+N"], desc: "新建 prompt" },
        { keys: ["Ctrl+F"], desc: "聚焦搜索框" },
        { keys: ["Ctrl+K"], desc: "打开 / 关闭命令面板" },
        { keys: ["Ctrl+Enter"], desc: "保存编辑" },
        { keys: ["?"], desc: "打开 / 关闭本速查表" },
      ],
    },
    {
      title: "编辑与列表",
      rows: [
        { keys: ["Enter"], desc: "标签输入框:确认并添加标签" },
        { keys: ["Enter"], desc: "变量弹窗:在最后一个输入框直接复制" },
        { keys: ["↑ ↓", "Enter", "Esc"], desc: "快速拾取:选择 / 复制 / 关闭" },
        { keys: ["Ctrl+A"], desc: "全选当前列表(多选)" },
        { keys: ["Esc"], desc: "清除多选 / 关闭弹窗" },
      ],
    },
  ];

  return (
    <Modal title="键盘快捷键" onCancel={onClose}>
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
          按 ? 或 Esc 关闭;全局热键可在设置中修改。
        </p>
      </div>
    </Modal>
  );
}
