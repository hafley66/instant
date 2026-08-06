import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PatchsetDiff } from "./DiffView";
import type { RefractorLike } from "./shikiTokens";
import type { ViewType } from "react-diff-view";

// Complex values arrive as properties; attributes carry primitives only, since
// React 19 sets a property when the instance declares one, an attribute otherwise.
export class PatchsetDiffElement extends HTMLElement {
  static observedAttributes = ["view-type", "diff-text"];

  private root: Root | null = null;
  private text = "";
  private highlighter: RefractorLike | undefined;
  private anchored: Record<string, unknown> | undefined;

  get diffText(): string {
    return this.text;
  }
  set diffText(value: string) {
    this.text = value ?? "";
    this.paint();
  }

  get refractor(): RefractorLike | undefined {
    return this.highlighter;
  }
  set refractor(value: RefractorLike | undefined) {
    this.highlighter = value;
    this.paint();
  }

  get widgets(): Record<string, unknown> | undefined {
    return this.anchored;
  }
  set widgets(value: Record<string, unknown> | undefined) {
    this.anchored = value;
    this.paint();
  }

  get viewType(): ViewType {
    return this.getAttribute("view-type") === "unified" ? "unified" : "split";
  }
  set viewType(value: ViewType) {
    this.setAttribute("view-type", value);
  }

  connectedCallback() {
    this.root ??= createRoot(this);
    this.paint();
  }

  disconnectedCallback() {
    const root = this.root;
    this.root = null;
    queueMicrotask(() => root?.unmount());
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === "diff-text") this.text = value ?? "";
    this.paint();
  }

  private paint() {
    this.root?.render(
      createElement(PatchsetDiff, {
        diffText: this.text,
        viewType: this.viewType,
        refractor: this.highlighter,
        widgets: this.anchored as never,
        empty: createElement(
          "div",
          { className: "patchset-diff-empty" },
          "No change between these patch sets.",
        ),
      }),
    );
  }
}

if (!customElements.get("patchset-diff")) {
  customElements.define("patchset-diff", PatchsetDiffElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "patchset-diff": PatchsetDiffElement;
  }
}
