// Captures what you do on every page — selections, copies, and DOM interactions
// (click / ctrl-click / dbl-click / drag / right-click) — relaying each to the
// background worker (which owns the localhost POST). No clipboard permission:
// the `copy` event and getSelection() are page-level and event-driven.
(function () {
  const MAX = 4000;

  function relay(kind, text) {
    const t = (text || "").trim();
    if (!t) return;
    chrome.runtime.sendMessage({
      kind,
      url: location.href,
      title: document.title,
      text: t.slice(0, MAX),
    });
  }

  // Explicit copy is high-signal — always send.
  document.addEventListener("copy", () => relay("clipboard", String(window.getSelection())));

  // Selection is noisy; debounce and require a non-trivial length.
  let selTimer;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const s = String(window.getSelection());
      if (s.trim().length > 8) relay("selection", s);
    }, 700);
  });

  // ---- DOM interactions: describe the target + which modifiers were held ----
  function describe(el) {
    if (!el || el.nodeType !== 1) return "";
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  }
  function mods(e) {
    const m = [];
    if (e.ctrlKey) m.push("ctrl");
    if (e.metaKey) m.push("cmd");
    if (e.shiftKey) m.push("shift");
    if (e.altKey) m.push("alt");
    return m.length ? ` [${m.join("+")}]` : "";
  }
  function context(e) {
    const el = e.target;
    const sel = describe(el);
    const label = (el.innerText || el.value || el.alt || "").trim().slice(0, 80);
    const link = el.closest && el.closest("a[href]");
    const href = link ? ` ${link.href}` : "";
    return `${sel}${label ? ` "${label}"` : ""}${href}${mods(e)}`;
  }

  // Per-kind throttle so click storms / drag bursts don't flood the ring.
  const last = {};
  function throttled(kind, ms) {
    const now = Date.now();
    if (last[kind] && now - last[kind] < ms) return false;
    last[kind] = now;
    return true;
  }

  document.addEventListener(
    "click",
    (e) => {
      const kind = e.ctrlKey || e.metaKey ? "ctrlclick" : "click";
      if (throttled(kind, 300)) relay(kind, context(e));
    },
    true,
  );
  document.addEventListener(
    "dblclick",
    (e) => {
      if (throttled("dblclick", 300)) relay("dblclick", context(e));
    },
    true,
  );
  document.addEventListener(
    "dragstart",
    (e) => {
      if (throttled("drag", 300)) relay("drag", context(e));
    },
    true,
  );
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (throttled("rclick", 300)) relay("rclick", context(e));
    },
    true,
  );
})();
