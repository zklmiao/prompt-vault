import type { SVGProps } from "react";

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconCopy(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

export function IconEdit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </Svg>
  );
}

export function IconTrash(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function IconPin(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  );
}

export function IconImport(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </Svg>
  );
}

export function IconExport(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </Svg>
  );
}

export function IconUndo(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </Svg>
  );
}

export function IconSun(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </Svg>
  );
}

export function IconMoon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Svg>
  );
}

export function IconX(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  );
}

export function IconClipboard(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M9 12h6M9 16h6" />
    </Svg>
  );
}

export function IconSparkles(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4M22 5h-4" />
    </Svg>
  );
}

export function IconTag(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </Svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function IconSettings(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function IconMinimize(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function IconMaximize(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5" y="5" width="14" height="14" rx="1" />
    </Svg>
  );
}

export function IconRestore(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="8" y="8" width="12" height="12" rx="1" />
      <path d="M5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1" />
    </Svg>
  );
}

/** 插件(拼图) */
export function IconPlugin(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 4.5a2 2 0 1 1 4 0H16a1 1 0 0 1 1 1v2.5a2 2 0 1 1 0 4V15a1 1 0 0 1-1 1h-2.5a2 2 0 1 1-4 0H7a1 1 0 0 1-1-1v-3a2 2 0 1 1 0-4V5.5a1 1 0 0 1 1-1h2.5z" />
    </Svg>
  );
}

/** 插件市场(店铺) */
export function IconMarket(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9.5 5.2 4.6A1 1 0 0 1 6.2 4h11.6a1 1 0 0 1 1 .6L20 9.5" />
      <path d="M4 9.5a2.2 2.2 0 0 0 4.3.7 2.2 2.2 0 0 0 4.3.1 2.2 2.2 0 0 0 4.3-.1 2.2 2.2 0 0 0 3.1-.7" />
      <path d="M5 12.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6.5" />
      <path d="M9.5 20v-5h5v5" />
    </Svg>
  );
}

/** 刷新(手动更新源清单) */
export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 3v4h-4" />
    </Svg>
  );
}

/** 弹出/外部打开(窗口+右上外指箭头):在独立窗口打开插件。与标题栏
    窗口控制图标(Maximize/Restore 纯矩形)刻意拉开,避免「窗口」语义撞车 */
export function IconPopout(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Svg>
  );
}

/** 右栏面板(窗口+右列分隔线):打开插件详情面板(宿主内的嵌入式页签) */
export function IconPanelRight(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </Svg>
  );
}

/** MCP Server(插头:即插即用的协议连接器) */
export function IconMcp(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 3.5V7" />
      <path d="M15 3.5V7" />
      <path d="M5.5 7h13v4.5a6.5 6.5 0 0 1-13 0V7z" />
      <path d="M12 18v3" />
    </Svg>
  );
}

/** 私人彩蛋「密语暗屉」(蝴蝶):24 viewBox 线性双翼 + 身体中线,与库内线性图标
    同族。本文件不含五色——彩蛋颜色例外集中在使用处与 App.css 彩蛋节 */
export function IconButterfly(p: IconProps) {
  return (
    <Svg {...p}>
      {/* 左翼(上叶 + 下叶,起收笔都落在身体中线上) */}
      <path d="M12 7C11.1 4.8 9 3 6.8 3 4.6 3 3 4.5 3 6.6c0 2.7 2.4 4.8 5.6 5.4C5.4 12.6 3 14.7 3 17.4 3 19.5 4.6 21 6.8 21c2.2 0 4.3-1.8 5.2-4" />
      {/* 右翼:同形镜像(x → 24−x,相对指令 dx 取反) */}
      <path d="M12 7C12.9 4.8 15 3 17.2 3 19.4 3 21 4.5 21 6.6c0 2.7-2.4 4.8-5.6 5.4C18.6 12.6 21 14.7 21 17.4 21 19.5 19.4 21 17.2 21c-2.2 0-4.3-1.8-5.2-4" />
      {/* 身体中线 */}
      <path d="M12 5.5V19" />
    </Svg>
  );
}

/** 私人彩蛋「3 月 31 日五色对勾」(仅 QuickPick 复制确认态):路径沿用 IconCheck
    的 M20 6 9 17l-5-5,双层描边——底层 --border-strong 细晕(加宽 +0.6px,保证
    五色中的白色中段在亮色 panel 底上可见),上层五色分段描边。尺寸接口同其他图标。
    评审调整(阶段 1)一:原 size={26} 时字形仅占 viewBox 一角(实际勾形 ~18×12px)
    显得过于克制,现收紧 viewBox 至字形包围盒(x 1.5..22.5 / y 3.5..19.5,含细晕
    与圆角端点余量)并由调用处传 size={40},勾形实际渲染 ~31×21px,描边比例不变。
    评审调整(阶段 1)二:先改分段硬切,终版回归克制渐变——每色实色平台 + 分界
    仅 6% 窄幅过渡(见 defs 注释) */
export function IconFlagCheck(p: IconProps) {
  return (
    <Svg viewBox="1.5 3.5 21 16" {...p}>
      <defs>
        {/* 私人彩蛋五色(#5BCEFA/#F5A9B8/#FFFFFF/#F5A9B8/#5BCEFA),
            全项目唯一硬编码颜色例外,有意不 token 化。
            评审调整(阶段 1):渐变克制——成对 stop 保留每色实色平台(14%/20%),
            分界仅 6% 窄幅过渡(原规格 25% 全程混色过于模糊扩散) */}
        <linearGradient id="pv-egg-flag-check" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#5BCEFA" />
          <stop offset="0.14" stopColor="#5BCEFA" />
          <stop offset="0.2" stopColor="#F5A9B8" />
          <stop offset="0.34" stopColor="#F5A9B8" />
          <stop offset="0.4" stopColor="#FFFFFF" />
          <stop offset="0.6" stopColor="#FFFFFF" />
          <stop offset="0.66" stopColor="#F5A9B8" />
          <stop offset="0.8" stopColor="#F5A9B8" />
          <stop offset="0.86" stopColor="#5BCEFA" />
          <stop offset="1" stopColor="#5BCEFA" />
        </linearGradient>
      </defs>
      {/* 底层细晕:stroke 走 CSS 变量(presentation attribute 不支持 var()) */}
      <path
        d="M20 6 9 17l-5-5"
        strokeWidth={2.4}
        style={{ stroke: "var(--border-strong)" }}
        pathLength={1}
        className="pv-egg-flag-draw"
      />
      {/* 上层五色描边(克制渐变:实色平台 + 6% 窄幅过渡) */}
      <path
        d="M20 6 9 17l-5-5"
        stroke="url(#pv-egg-flag-check)"
        pathLength={1}
        className="pv-egg-flag-draw"
      />
    </Svg>
  );
}
