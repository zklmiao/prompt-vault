// 浏览器预览夹具:模拟 @tauri-apps/plugin-dialog(纯浏览器里不能弹原生对话框)
export async function save() {
  console.log("[mock] dialog.save -> cancelled");
  return null;
}

export async function open() {
  console.log("[mock] dialog.open -> cancelled");
  return null;
}
