// Captures what you select and copy on every page, relaying to the background
// worker (which owns the localhost POST). No clipboard permission needed: the
// `copy` event and window.getSelection() are page-level and event-driven.
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
  let timer;
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = String(window.getSelection());
      if (s.trim().length > 8) relay("selection", s);
    }, 700);
  });
})();
