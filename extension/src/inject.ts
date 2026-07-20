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
  const pending: Array<{ method: string; url: string; body: unknown; status?: number }> = [];

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

  function post(type: "seen" | "response" | "error", method: string, url: string, extra: Record<string, unknown> = {}) {
    try {
      window.postMessage({ source: "ext-netcapture", type, method, url, ts: Date.now(), ...extra }, "*");
    } catch {
      /* not cloneable — drop */
    }
  }

  function candidate(method: string, url: string): boolean {
    return wanted(method, url) || /usage/i.test(url);
  }

  function announce(method: string, url: string) {
    if (candidate(method, url)) post("seen", method, url);
  }

  function deliver(method: string, url: string, body: unknown, status?: number) {
    if (wanted(method, url)) post("response", method, url, { body, status });
    else if (/usage/i.test(url)) {
      pending.push({ method, url, body, status });
      if (pending.length > 8) pending.shift();
    }
  }

  function flush() {
    for (const item of pending.splice(0)) {
      if (wanted(item.method, item.url)) {
        post("response", item.method, item.url, { body: item.body, status: item.status });
      }
    }
  }

  new MutationObserver(flush).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ATTR],
  });

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const req = args[0];
      const rawUrl = typeof req === "string" ? req : (req as Request)?.url || "";
      const url = rawUrl ? new URL(rawUrl, location.href).href : "";
      const method = typeof req === "string" ? (args[1] as RequestInit | undefined)?.method || "GET" : (req as Request)?.method || "GET";
      announce(method, url);
      const p = origFetch.apply(this as never, args);
      if (candidate(method, url)) {
        p.then((resp) => {
          resp.clone().json().then((j) => deliver(method, url, j, resp.status)).catch(() => {});
        }).catch((error) => post("error", method, url, { detail: String(error) }));
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
    this.__extUrl = new URL(url, location.href).href;
    this.__extMethod = method;
    // @ts-expect-error variadic passthrough to the native open
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function (this: typeof XHR, ...a: unknown[]) {
    if (this.__extUrl && candidate(this.__extMethod || "GET", this.__extUrl)) {
      const url = this.__extUrl;
      const method = this.__extMethod || "GET";
      announce(method, url);
      this.addEventListener("load", function (this: XMLHttpRequest) {
        try {
          deliver(method, url, JSON.parse(this.responseText), this.status);
        } catch (error) {
          post("error", method, url, { status: this.status, detail: String(error) });
        }
      });
      this.addEventListener("error", () => post("error", method, url, { detail: "XHR error" }));
    }
    // @ts-expect-error variadic passthrough to the native send
    return origSend.apply(this, a);
  };
})();
