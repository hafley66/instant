import { useState } from "react";
import type { MemeCaption, PaintBridge } from "./paintBridge";

const blank = (): MemeCaption => ({ text: "", family: "Impact", size: 56, bold: false, italic: false, underline: false, strikethrough: false, fill: "#ffffff", stroke: "#000000", strokeWidth: 4 });

function CaptionFields({ label, value, onChange }: { label: string; value: MemeCaption; onChange: (next: MemeCaption) => void }) {
  const set = <K extends keyof MemeCaption>(key: K, next: MemeCaption[K]) => onChange({ ...value, [key]: next });
  return <fieldset className="paint-caption-fields"><legend>{label}</legend>
    <textarea aria-label={`${label} text`} value={value.text} onChange={(event) => set("text", event.currentTarget.value)} />
    <select aria-label={`${label} font family`} value={value.family} onChange={(event) => set("family", event.currentTarget.value)}><option>Impact</option><option>Arial</option><option>Helvetica</option><option>Verdana</option><option>Times New Roman</option></select>
    <label>size<input aria-label={`${label} font size`} type="number" min="8" max="400" value={value.size} onChange={(event) => set("size", Number(event.currentTarget.value))} /></label>
    <span className="paint-caption-toggles">{(["bold", "italic", "underline", "strikethrough"] as const).map((key) => <label key={key}><input type="checkbox" checked={value[key]} onChange={(event) => set(key, event.currentTarget.checked)} />{key === "strikethrough" ? "strike" : key}</label>)}</span>
    <label>fill<input aria-label={`${label} fill color`} type="color" value={value.fill} onChange={(event) => set("fill", event.currentTarget.value)} /></label>
    <label>stroke<input aria-label={`${label} stroke color`} type="color" value={value.stroke} onChange={(event) => set("stroke", event.currentTarget.value)} /></label>
    <label>stroke px<input aria-label={`${label} stroke width`} type="number" min="0" max="32" value={value.strokeWidth} onChange={(event) => set("strokeWidth", Number(event.currentTarget.value))} /></label>
  </fieldset>;
}

export function PaintMemeControls({ bridge }: { bridge: PaintBridge | null }) {
  const [top, setTop] = useState(blank);
  const [bottom, setBottom] = useState(blank);
  return <aside className="paint-meme-controls" data-testid="meme-captions"><strong>meme captions</strong><CaptionFields label="top" value={top} onChange={setTop} /><CaptionFields label="bottom" value={bottom} onChange={setBottom} /><button type="button" disabled={!bridge || (!top.text.trim() && !bottom.text.trim())} onClick={() => void bridge?.applyMemeCaptions(top, bottom)}>add caption layers</button></aside>;
}
