import { runtimePorts } from "./reactive/ports";

export async function openExternal(path: string): Promise<void> {
  await runtimePorts.window.hide();
  try {
    await runtimePorts.openPath(path);
  } catch (error) {
    await runtimePorts.window.show();
    throw error;
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  await runtimePorts.window.hide();
  try {
    await runtimePorts.openUrl(url);
  } catch (error) {
    await runtimePorts.window.show();
    throw error;
  }
}

/** Show the file in Finder without hiding Instant: the user is picking, not leaving. */
export async function revealExternal(path: string): Promise<void> {
  await runtimePorts.revealItemInDir(path);
}
