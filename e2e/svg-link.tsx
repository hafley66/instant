import { createRoot } from "react-dom/client";
import { SvgDocumentViewer } from "../src/1_SvgDocumentViewer";
import "../src/styles.css";

declare global {
  interface Window { __openedSvgHref?: string }
}

const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">
  <rect width="800" height="500" fill="#101827"/>
  <a href="file:///tmp/svg-link-target.ts#L144">
    <rect x="220" y="170" width="360" height="140" rx="12" fill="#dbeafe" stroke="#2563eb" stroke-width="5"/>
        <text x="400" y="250" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#111827">Clickable file:line link</text>
  </a>
</svg>`;

createRoot(document.getElementById("root")!).render(
  <div style={{ width: "800px", height: "500px" }}>
    <SvgDocumentViewer
      path="/tmp/svg-link-receipt.svg"
      source={source}
      onOpenHref={(href) => { window.__openedSvgHref = href }}
    />
  </div>,
);
