import { createRoot } from "react-dom/client";
import { MonacoCodeViewer, editorState } from "../src/0_MonacoCodeViewer";
import "../src/styles.css";

const path = "/tmp/instant-monaco/sample.ts";
const text = `type Receipt = { renderer: "monaco"; mounted: boolean };

export const receipt: Receipt = {
  renderer: "monaco",
  mounted: true,
};
`;

(window as Window & { __instantE2eNativeResults?: Record<string, unknown> }).__instantE2eNativeResults = {
  save_text: null,
};
(window as Window & { __monacoState?: () => unknown }).__monacoState = () => editorState.$();

createRoot(document.getElementById("root")!).render(
  <MonacoCodeViewer id={path} path={path} text={text} dark line={3} />,
);
