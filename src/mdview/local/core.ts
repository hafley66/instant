// Vendored copy for package extraction: kept identical in behavior to the
// same-named exports in the app's ../../core so src/mdview stays standalone.
// If the app's core.ts changes baseName or MD_EXTS, mirror the change here.

export const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// File extension set the viewer treats as markdown (routing, explorer filter).
export const MD_EXTS = new Set(["md", "markdown", "mdx"]);
