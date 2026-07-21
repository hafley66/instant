import { concatMap, exhaustMap, from, map, Subject, type Observable } from "rxjs";
import type { Event, JsonValue } from "../../src/lib/json-rx/0_types";
import {
  chromeBrowserEffects,
  executeBrowserEffect,
  type BrowserEffectResult,
  type BrowserEffectsPort,
} from "./4_browserEffects";
import type { IntervalPipeSchedule, RuleEffect, Schedule } from "./0_types";

type ScheduleTick = { ruleId: string; ts: number };

export type BrowserScheduleRuntime = {
  dispatch: (ruleId: string) => void;
  close: () => void;
};

export function isIntervalPipeSchedule(schedule: Schedule): schedule is IntervalPipeSchedule {
  return typeof schedule === "object"
    && "source" in schedule
    && typeof schedule.source?.interval?.periodMs === "number"
    && Array.isArray(schedule.pipe)
    && schedule.pipe.length === 1
    && schedule.pipe[0]?.exhaustMap?.effect != null;
}

export function schedulePeriodMs(schedule: Schedule | undefined): number | null {
  if (!schedule || schedule === "passive") return null;
  if (isIntervalPipeSchedule(schedule)) return schedule.source.interval.periodMs;
  return typeof schedule.intervalMin === "number" ? schedule.intervalMin * 60_000 : null;
}

function scheduleEffects(schedule: Exclude<Schedule, "passive">): RuleEffect[] {
  if (isIntervalPipeSchedule(schedule)) return [schedule.pipe[0].exhaustMap.effect];
  return schedule.effects ?? [];
}

function resultEvent(tick: ScheduleTick, result: BrowserEffectResult): Event {
  return {
    type: result.type,
    causationId: `${tick.ruleId}:${tick.ts}`,
    data: result as unknown as JsonValue,
  };
}

function executeEffects(
  tick: ScheduleTick,
  effects: RuleEffect[],
  port: BrowserEffectsPort,
): Observable<Event> {
  return from(effects).pipe(
    concatMap((effect) => from(executeBrowserEffect(effect, port))),
    map((result) => resultEvent(tick, result)),
  );
}

export function createBrowserScheduleRuntime(
  schedule: Exclude<Schedule, "passive">,
  report: (event: Event) => void,
  port: BrowserEffectsPort = chromeBrowserEffects,
): BrowserScheduleRuntime {
  const effects = scheduleEffects(schedule);
  if (!effects.length) throw new Error("Browser schedule runtime requires an effect pipeline");
  const ticks = new Subject<ScheduleTick>();
  const subscription = ticks.pipe(
    exhaustMap((tick) => executeEffects(tick, effects, port)),
  ).subscribe(report);
  return {
    dispatch: (ruleId) => ticks.next({ ruleId, ts: Date.now() }),
    close: () => {
      subscription.unsubscribe();
      ticks.complete();
    },
  };
}
