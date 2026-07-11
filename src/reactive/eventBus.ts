import { Subject, type Observable } from "rxjs";
import type { AppEvents } from "./events";

export interface EventBus<E extends object> {
  emit<K extends keyof E>(type: K, payload: E[K]): void;
  on<K extends keyof E>(type: K): Observable<E[K]>;
  close(): void;
}

export function createEventBus<E extends object>(): EventBus<E> {
  const subjects = new Map<keyof E, Subject<E[keyof E]>>();
  const subject = <K extends keyof E>(type: K) => {
    let found = subjects.get(type);
    if (!found) {
      found = new Subject<E[keyof E]>();
      subjects.set(type, found);
    }
    return found as unknown as Subject<E[K]>;
  };
  return {
    emit: (type, payload) => subject(type).next(payload),
    on: (type) => subject(type).asObservable(),
    close: () => {
      for (const value of subjects.values()) value.complete();
      subjects.clear();
    },
  };
}

export type ApplicationEventBus = EventBus<AppEvents>;
