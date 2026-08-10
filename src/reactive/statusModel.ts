import { Signal, storageSignal } from "@hafley66/signals";
import { Observable } from "rxjs";
import type { StatusReport } from "../plugin";
import { aggregateStatus } from "./statusDerivations";

export interface StatusRow {
  id: string;
  label: string;
  report: StatusReport;
}

export const statusRows = Signal<StatusRow[]>([]);
export const aggregateHealth = Signal(() => aggregateStatus(statusRows.$()));

export function createSprefaRoot(storage: Storage = localStorage) {
  const key = "sprefa.root";
  return storageSignal({
    read: new Observable<string>((subscriber) => {
      const emit = () => subscriber.next(storage.getItem(key) ?? "");
      const onStorage = (event: StorageEvent) => {
        if (event.storageArea === storage && event.key === key) emit();
      };
      if (typeof addEventListener === "function") addEventListener("storage", onStorage);
      emit();
      return () => {
        if (typeof removeEventListener === "function") removeEventListener("storage", onStorage);
      };
    }),
    write: {
      next: (value) => storage.setItem(key, value),
      error() {},
      complete() {},
    },
  }, "~/projects/sprefa/v5", {
    parse: (value) => value,
    serialize: (value) => value,
  });
}

export const sprefaRoot = createSprefaRoot();
// todo(lifecycle): make StorageSignal external-listener teardown runtime-owned (depends: Signals storage disposal API)
