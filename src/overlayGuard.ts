// Runtime guards for overlay auto-hide behavior. Kept tiny and separate so
// panels can suppress blur-to-hide without creating import cycles with main.ts.

let filePickerOpen = false;

export function setFilePickerOpen(open: boolean) {
  filePickerOpen = open;
}

export function isFilePickerOpen(): boolean {
  return filePickerOpen;
}
