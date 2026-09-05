import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

export async function openExternal(path: string): Promise<void> {
  const window = getCurrentWindow();
  await window.hide();
  try {
    await openPath(path);
  } catch (error) {
    await window.show();
    throw error;
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  const window = getCurrentWindow();
  await window.hide();
  try {
    await openUrl(url);
  } catch (error) {
    await window.show();
    throw error;
  }
}

/** Show the file in Finder without hiding Instant: the user is picking, not leaving. */
export async function revealExternal(path: string): Promise<void> {
  await revealItemInDir(path);
}
