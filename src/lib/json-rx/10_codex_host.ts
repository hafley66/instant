import { concat, defer, from, map, of, Subject, type Observable } from "rxjs";
import * as z from "zod";
import type { HostEvent, RuntimeSource } from "@hafley66/json-rx";

export const CODEX_HOST_OPERATIONS = {
  rateLimitsRead: "account/rateLimits/read",
  rateLimitsUpdated: "account/rateLimits/updated",
} as const;

export const CODEX_HOST_URLS = {
  rateLimitsRead: "codex-app-server://account/rateLimits/read",
  rateLimitsUpdated: "codex-app-server://account/rateLimits/updated",
} as const;

export const CODEX_HOST_STATUS = {
  live: false,
  state: "pending-host",
  message: "Live Codex app-server transport is pending a host-owned adapter.",
  operations: [CODEX_HOST_OPERATIONS.rateLimitsRead, CODEX_HOST_OPERATIONS.rateLimitsUpdated],
} as const;

const NullableNumber = z.number().finite().nullable();
const NullableString = z.string().nullable();
const NullableBoolean = z.boolean().nullable();

export const CodexUsageSchema = z.strictObject({
  provider: z.string(),
  primary_percent: NullableNumber,
  primary_resets_at: NullableString,
  secondary_percent: NullableNumber,
  secondary_resets_at: NullableString,
  credit_balance: NullableNumber,
  has_credits: NullableBoolean,
  plan_type: NullableString,
});

export type CodexUsage = z.infer<typeof CodexUsageSchema>;
export type CodexRateLimitsSnapshot = CodexUsage;
export type CodexRateLimitsUpdate = Partial<CodexUsage>;

export type CodexRateLimitsProtocolResponse = {
  rateLimitsByLimitId?: { codex?: Record<string, unknown> };
  rateLimits?: Record<string, unknown>;
  [key: string]: unknown;
};

export type CodexHostAdapter = {
  rateLimitsRead: () => Observable<CodexRateLimitsSnapshot>;
  rateLimitsUpdated$: Observable<CodexRateLimitsUpdate>;
};

export type CodexProtocolHostAdapter = {
  rateLimitsRead: () => Observable<CodexRateLimitsProtocolResponse>;
  rateLimitsUpdated$: Observable<CodexRateLimitsProtocolResponse>;
};

export type CodexHostSources = {
  snapshot: Observable<RuntimeSource>;
  updated: Observable<RuntimeSource>;
};

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function field(input: Record<string, unknown>, ...names: string[]): unknown {
  return names.map((name) => input[name]).find((value) => value !== undefined);
}

function resetIso(value: unknown): string | null {
  const number = numberValue(value);
  if (number === null) return stringValue(value);
  const milliseconds = number < 10_000_000_000 ? number * 1000 : number;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function bucket(input: CodexRateLimitsProtocolResponse): Record<string, unknown> {
  return input.rateLimitsByLimitId?.codex ?? input.rateLimits ?? input;
}

function windowValue(input: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const value = field(input, ...names);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeCodexRateLimits(input: CodexRateLimitsProtocolResponse): CodexUsage {
  const limits = bucket(input);
  const primary = windowValue(limits, ["primary", "fiveHour", "five_hour"]);
  const secondary = windowValue(limits, ["secondary", "sevenDay", "seven_day"]);
  return CodexUsageSchema.parse({
    provider: stringValue(field(limits, "provider", "name")) ?? "Codex",
    primary_percent: numberValue(field(primary, "usedPercent", "used_percent", "utilization", "percent")),
    primary_resets_at: resetIso(field(primary, "resetsAt", "resets_at")),
    secondary_percent: numberValue(field(secondary, "usedPercent", "used_percent", "utilization", "percent")),
    secondary_resets_at: resetIso(field(secondary, "resetsAt", "resets_at")),
    credit_balance: numberValue(field(limits, "creditBalance", "credit_balance", "balance")),
    has_credits: booleanValue(field(limits, "hasCredits", "has_credits")),
    plan_type: stringValue(field(limits, "planType", "plan_type", "plan")),
  });
}

export function normalizeCodexRateLimitsUpdate(input: CodexRateLimitsProtocolResponse): CodexRateLimitsUpdate {
  const limits = bucket(input);
  const primary = windowValue(limits, ["primary", "fiveHour", "five_hour"]);
  const secondary = windowValue(limits, ["secondary", "sevenDay", "seven_day"]);
  const update: CodexRateLimitsUpdate = {};
  const primaryPercent = field(primary, "usedPercent", "used_percent", "utilization", "percent");
  const primaryReset = field(primary, "resetsAt", "resets_at");
  const secondaryPercent = field(secondary, "usedPercent", "used_percent", "utilization", "percent");
  const secondaryReset = field(secondary, "resetsAt", "resets_at");
  if (primaryPercent !== undefined) update.primary_percent = numberValue(primaryPercent);
  if (primaryReset !== undefined) update.primary_resets_at = resetIso(primaryReset);
  if (secondaryPercent !== undefined) update.secondary_percent = numberValue(secondaryPercent);
  if (secondaryReset !== undefined) update.secondary_resets_at = resetIso(secondaryReset);
  const credit = field(limits, "creditBalance", "credit_balance", "balance");
  const credits = field(limits, "hasCredits", "has_credits");
  const plan = field(limits, "planType", "plan_type", "plan");
  if (credit !== undefined) update.credit_balance = numberValue(credit);
  if (credits !== undefined) update.has_credits = booleanValue(credits);
  if (plan !== undefined) update.plan_type = stringValue(plan);
  return update;
}

function hostEvent(type: string, data: CodexUsage | CodexRateLimitsUpdate, url: string, ts: number): HostEvent {
  return { type, data: data as HostEvent["data"], url, ts };
}

export function codexHostSources(host: CodexHostAdapter, now: () => number = Date.now): CodexHostSources {
  return {
    snapshot: defer(() => host.rateLimitsRead()).pipe(
      map((value) => hostEvent("codex.usage.snapshot", value, CODEX_HOST_URLS.rateLimitsRead, now())),
    ),
    updated: host.rateLimitsUpdated$.pipe(
      map((value) => hostEvent("codex.usage.updated", value, CODEX_HOST_URLS.rateLimitsUpdated, now())),
    ),
  };
}

export function codexProtocolHostAdapter(host: CodexProtocolHostAdapter): CodexHostAdapter {
  return {
    rateLimitsRead: () => host.rateLimitsRead().pipe(map(normalizeCodexRateLimits)),
    rateLimitsUpdated$: host.rateLimitsUpdated$.pipe(map(normalizeCodexRateLimitsUpdate)),
  };
}

export function createFakeCodexHostAdapter(
  snapshot: CodexRateLimitsSnapshot,
  updates: CodexRateLimitsUpdate[] = [],
): CodexHostAdapter & { emitUpdate: (update: CodexRateLimitsUpdate) => void } {
  const updated$ = new Subject<CodexRateLimitsUpdate>();
  return {
    rateLimitsRead: () => defer(() => of(snapshot)),
    rateLimitsUpdated$: concat(from(updates), updated$),
    emitUpdate: (update) => updated$.next(update),
  };
}
