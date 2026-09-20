// Completed results have a byte budget; concurrent opens of the same source
// share one render. Failed attempts are removed so a retry can recover.
export class DiagramRenderCache {
  entries = new Map<string, { promise: Promise<string>; bytes: number }>();
  bytes = 0;
  constructor(readonly maxBytes = 8 * 1024 * 1024, readonly maxEntries = 32) {}

  render(language: string, source: string, dark: boolean, render: () => Promise<string>): Promise<string> {
    const key = `${language}:${dark}:${source}`;
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }
    const entry = { promise: Promise.resolve().then(render), bytes: key.length * 2 };
    entry.promise = entry.promise.then((svg) => {
      if (this.entries.get(key) === entry) {
        entry.bytes += svg.length * 2;
        this.bytes += svg.length * 2;
        this.trim();
      }
      return svg;
    }, (error) => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
        this.bytes -= entry.bytes;
      }
      throw error;
    });
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    this.trim();
    return entry.promise;
  }

  trim() {
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
  }
}
