// MAIN-world fetch/XHR interceptor. Runs at document_start so it wraps the real
// window.fetch / XMLHttpRequest before the app issues requests. Generalizes
// local-ext inject_main.js:23-54: instead of a hardcoded /usage/i test, it reads
// the netcapture URL patterns the isolated relay writes to a DOM attribute (the
// one channel both worlds share) and posts matching JSON responses back to it.
//
// Kept dependency-free: MAIN world can't reach chrome.* or module scope, and the
// wrapper runs on every request, so it stays small and self-contained.
(function () {
  const ATTR = "data-ext-netcapture"; // JSON array of regex source strings

  function patterns(): RegExp[] {
    try {
      const raw = document.documentElement.getAttribute(ATTR);
      if (!raw) return [];
      const arr = JSON.parse(raw) as string[];
      return arr
        .map((p) => {
          try {
            return new RegExp(p);
          } catch {
            return null;
          }
        })
        .filter((r): r is RegExp => r !== null);
    } catch {
      return [];
    }
  }

  function wanted(url: string): boolean {
    if (typeof url !== "string" || !url) return false;
    return patterns().some((re) => re.test(url));
  }

  function post(url: string, body: unknown) {
    try {
      window.postMessage({ source: "ext-netcapture", url, ts: Date.now(), body }, "*");
    } catch {
      /* not cloneable — drop */
    }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const req = args[0];
      const url = typeof req === "string" ? req : (req as Request)?.url || "";
      const p = origFetch.apply(this as never, args);
      if (wanted(url)) {
        p.then((resp) => {
          resp
            .clone()
            .json()
            .then((j) => post(url, j))
            .catch(() => {});
        }).catch(() => {});
      }
      return p;
    };
  }

  const XHR = XMLHttpRequest.prototype as XMLHttpRequest & {
    __extUrl?: string;
  };
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (this: typeof XHR, method: string, url: string, ...rest: unknown[]) {
    this.__extUrl = url;
    // @ts-expect-error variadic passthrough to the native open
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function (this: typeof XHR, ...a: unknown[]) {
    if (this.__extUrl && wanted(this.__extUrl)) {
      const url = this.__extUrl;
      this.addEventListener("load", function (this: XMLHttpRequest) {
        try {
          post(url, JSON.parse(this.responseText));
        } catch {
          /* not JSON */
        }
      });
    }
    // @ts-expect-error variadic passthrough to the native send
    return origSend.apply(this, a);
  };
})();
