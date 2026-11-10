import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export async function windowMode(fullscreen?: boolean) {
  if (!isTauri()) return;
  const win = getCurrentWindow();
  const next = fullscreen ?? !(await win.isFullscreen());
  if (!next) await win.setDecorations(true);
  await win.setFullscreen(next);
  if (next) await win.setDecorations(false);
}

export async function minimizeWindowToDesktop() {
  if (!isTauri()) return;
  await getCurrentWindow().minimize();
}
