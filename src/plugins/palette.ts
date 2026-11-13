// 插件命令进命令面板的 UI 无关形状(由 App.tsx 补充 icon/group)

export interface PluginPaletteCommand {
  id: string;
  label: string;
  keywords?: string[];
  run: () => void;
}
