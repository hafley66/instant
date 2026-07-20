import { createEffectMachineRuntime } from "../../src/lib/json-rx/7_effects";
import type { Effect, Event, JsonObject, JsonValue, Machine } from "../../src/lib/json-rx/0_types";
import { chromeBrowserEffects, executeBrowserEffect } from "./4_browserEffects";

const scheduleMachine: Machine = {
  initial: { value: "idle", completed: 0, failed: 0 },
  transition: (state, event) => {
    if (event.type === "schedule.tick") {
      const effects = (event.data as JsonObject).effects as unknown as Effect[];
      return {
        updates: [{ op: "set", path: "/value", value: "running" }],
        effects,
      };
    }
    if (event.type === "browser.effect.next" || event.type === "browser.effect.error") {
      const field = event.type === "browser.effect.next" ? "completed" : "failed";
      return {
        updates: [
          { op: "set", path: "/value", value: "idle" },
          { op: "set", path: `/${field}`, value: Number(state[field] ?? 0) + 1 },
        ],
      };
    }
    return {};
  },
};

export function createBrowserScheduleRuntime(report: (event: Event) => void) {
  const runtime = createEffectMachineRuntime(scheduleMachine, async (effect, cause) => {
    const result = await executeBrowserEffect(effect, chromeBrowserEffects);
    return {
      type: result.type,
      causationId: effect.id ?? cause.id,
      data: result as unknown as JsonValue,
    };
  });
  const subscription = runtime.emissions$.subscribe((emission) => {
    if (emission.event.type.startsWith("browser.effect.")) report(emission.event);
  });
  return {
    dispatch: (ruleId: string, effects: Effect[]) => runtime.dispatch({
      type: "schedule.tick",
      id: `${ruleId}:${Date.now()}`,
      data: { ruleId, effects } as unknown as JsonValue,
    }),
    close: () => {
      subscription.unsubscribe();
      runtime.close();
    },
  };
}
