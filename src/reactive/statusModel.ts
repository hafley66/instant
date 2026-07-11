import { Signal, StorageSignal } from "@hafley66/signals";
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
  return StorageSignal("sprefa.root", "~/projects/sprefa/v5", {
    storage,
    parse: (value) => value,
    serialize: (value) => value,
  });
}

export const sprefaRoot = createSprefaRoot();
// todo(lifecycle): make StorageSignal external-listener teardown runtime-owned (depends: Signals storage disposal API)
