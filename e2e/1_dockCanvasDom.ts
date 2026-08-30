import { Observable, share } from "rxjs";

type Values<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
  ? Record<Param | keyof Values<`/${Rest}`>, string | number>
  : Path extends `${string}:${infer Param}` ? Record<Param, string | number> : Record<never, never>;

function fill(path: string, values: Record<string, string | number>) {
  return path.split("/").map((segment) => segment.startsWith(":")
    ? encodeURIComponent(String(values[segment.slice(1)]))
    : segment).join("/");
}

// Source-compatible lab adapter for @hafley/rxjs-ext Dom().
export function Dom<const Path extends string>(template: Path) {
  const keys: string[] = [];
  const pattern = template.split("/").map((segment) => {
    if (!segment.startsWith(":")) return segment;
    keys.push(segment.slice(1));
    return "([^/]+)";
  }).join("/");
  const regex = new RegExp(`^${pattern}$`);
  const events = new Map<string, Observable<MouseEvent & { delegateElement: HTMLElement; params: Record<string, string> }>>();
  return {
    id: (values: Values<Path>) => fill(template, values),
    $: new Proxy({}, { get: (_, eventName: string) => {
      const cached = events.get(eventName);
      if (cached) return cached;
      const source = new Observable<MouseEvent & { delegateElement: HTMLElement; params: Record<string, string> }>((subscriber) => {
        const listener = (event: Event) => {
          const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[id]") : null;
          const match = element ? regex.exec(element.id) : null;
          if (!element || !match) return;
          subscriber.next(Object.assign(event, {
            delegateElement: element,
            params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])),
          }) as MouseEvent & { delegateElement: HTMLElement; params: Record<string, string> });
        };
        document.addEventListener(eventName, listener);
        return () => document.removeEventListener(eventName, listener);
      }).pipe(share());
      events.set(eventName, source);
      return source;
    } }) as {
      click: Observable<MouseEvent & { delegateElement: HTMLElement; params: Record<string, string> }>;
      input: Observable<InputEvent & { delegateElement: HTMLElement; params: Record<string, string> }>;
    },
  };
}
