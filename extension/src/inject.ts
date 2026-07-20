// MAIN-world fetch/XHR interceptor. Runs at document_start so it wraps the real
// window.fetch / XMLHttpRequest before the app issues requests. Generalizes
// local-ext inject_main.js:23-54: instead of a hardcoded /usage/i test, it reads
// the netcapture URL patterns the isolated relay writes to a DOM attribute (the
// one channel both worlds share) and posts matching JSON responses back to it.
//
// Kept dependency-free: MAIN world can't reach chrome.* or module scope, and the
// wrapper runs on every request, so it stays small and self-contained.
(function () {
  const ATTR = "data-ext-netcapture"; // JSON array of URL strings or method-aware patterns

  function patterns(): Array<string | { url?: string; methods?: string[] }> {
    try {
      const raw = document.documentElement.getAttribute(ATTR);
      if (!raw) return [];
      const arr = JSON.parse(raw) as string[];
      return arr;
    } catch {
      return [];
    }
  }

  function wanted(method: string, url: string): boolean {
    if (typeof url !== "string" || !url) return false;
    return patterns().some((p) => {
      if (typeof p === "string") {
        try { return new RegExp(p).test(url); } catch { return false; }
      }
      const methods = Array.isArray(p.methods) ? p.methods : [];
      if (methods.length && !methods.includes(method.toUpperCase())) return false;
      if (!p.url) return true;
      try { return new RegExp(p.url).test(url); } catch { return false; }
    });
  }

  function post(method: string, url: string, body: unknown) {
    try {
      window.postMessage({ source: "ext-netcapture", method, url, ts: Date.now(), body }, "*");
    } catch {
      /* not cloneable — drop */
    }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const req = args[0];
      const url = typeof req === "string" ? req : (req as Request)?.url || "";
      const method = typeof req === "string" ? (args[1] as RequestInit | undefined)?.method || "GET" : (req as Request)?.method || "GET";
      const p = origFetch.apply(this as never, args);
      if (wanted(method, url)) {
        p.then((resp) => {
          resp
            .clone()
            .json()
            .then((j) => post(method, url, j))
            .catch(() => {});
        }).catch(() => {});
      }
      return p;
    };
  }

  const XHR = XMLHttpRequest.prototype as XMLHttpRequest & {
    __extUrl?: string;
    __extMethod?: string;
  };
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (this: typeof XHR, method: string, url: string, ...rest: unknown[]) {
    this.__extUrl = url;
    this.__extMethod = method;
    // @ts-expect-error variadic passthrough to the native open
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function (this: typeof XHR, ...a: unknown[]) {
    if (this.__extUrl && wanted(this.__extMethod || "GET", this.__extUrl)) {
      const url = this.__extUrl;
      const method = this.__extMethod || "GET";
      this.addEventListener("load", function (this: XMLHttpRequest) {
        try {
          post(method, url, JSON.parse(this.responseText));
        } catch {
          /* not JSON */
        }
      });
    }
    // @ts-expect-error variadic passthrough to the native send
    return origSend.apply(this, a);
  };
})();
