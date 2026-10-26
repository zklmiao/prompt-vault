// 浏览器预览夹具:模拟 @tauri-apps/plugin-clipboard-manager
export async function writeText(text: string) {
  (window as unknown as { __lastCopied?: string }).__lastCopied = text;
  console.log("[mock] clipboard <-", text.slice(0, 80));
}

export async function readText(): Promise<string | null> {
  const v = (window as unknown as { __lastCopied?: string }).__lastCopied;
  return v ?? null;
}
