import { createRoot } from "react-dom/client";
import { FileImageViewer } from "../src/1_FileImageViewer";
import "../src/styles.css";

declare global {
  interface Window { __openedSvgHref?: string }
}

const source = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 800 500">
  <svg class="d2-svg" width="800" height="500" viewBox="0 0 800 500">
    <rect width="800" height="500" fill="#101827"/>
    <a href="vscode://file/tmp/svg-link-target.ts:144" xlink:href="vscode://file/tmp/svg-link-target.ts:144">
      <g class="linked-node">
        <path d="M 220 170 L 580 170 L 550 310 L 190 310 Z" fill="#dbeafe" stroke="#2563eb" stroke-width="5"/>
        <text x="400" y="250" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#111827">Clickable file:line link</text>
      </g>
    </a>
    <path d="M 400 310 L 400 430 L 470 390 M 400 430 L 330 390" fill="none" stroke="#60a5fa" stroke-width="8"/>
  </svg>
</svg>`;

const root = document.getElementById("root")!;
createRoot(root).render(
  <div style={{ width: "800px", height: "500px" }}>
    <FileImageViewer path="/tmp/svg-link-receipt.svg" svg={source} probeRoot={root} onOpenHref={(href) => { window.__openedSvgHref = href }} />
  </div>,
);
