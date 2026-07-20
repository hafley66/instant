import type { RuleEffect } from "./0_types";

export type BrowserContextTarget = {
  url: string;
  active?: boolean;
  idleForMs?: number;
  cardinality?: "one" | "all";
};

export type BrowserContext = {
  id: number;
  url: string;
  active: boolean;
  lastAccessed: number;
};

export type BrowserEffectResult = {
  type: "browser.effect.next" | "browser.effect.error";
  effectId: string;
  op: string;
  contexts: number[];
  error?: string;
};

export interface BrowserEffectsPort {
  contexts(): Promise<BrowserContext[]>;
  reload(contextId: number, ignoreCache: boolean): Promise<void>;
}

type ReloadInput = {
  target: BrowserContextTarget;
  ignoreCache?: boolean;
};

function reloadInput(effect: RuleEffect): ReloadInput {
  if (effect.op !== "browsingContext.reload") throw new Error(`Unsupported browser effect: ${effect.op}`);
  const input = effect.input as Partial<ReloadInput> | undefined;
  if (!input?.target || typeof input.target.url !== "string") {
    throw new Error("browsingContext.reload requires input.target.url");
  }
  return input as ReloadInput;
}

export function resolveBrowserContexts(
  contexts: BrowserContext[],
  target: BrowserContextTarget,
  now = Date.now(),
): BrowserContext[] {
  const url = new RegExp(target.url);
  const matches = contexts
    .filter((context) => url.test(context.url))
    .filter((context) => target.active === undefined || context.active === target.active)
    .filter((context) => target.idleForMs === undefined || now - context.lastAccessed >= target.idleForMs)
    .sort((a, b) => b.lastAccessed - a.lastAccessed || a.id - b.id);
  return target.cardinality === "all" ? matches : matches.slice(0, 1);
}

export async function executeBrowserEffect(
  effect: RuleEffect,
  port: BrowserEffectsPort,
  now = Date.now(),
): Promise<BrowserEffectResult> {
  const effectId = effect.id ?? `${effect.op}:${now}`;
  try {
    const input = reloadInput(effect);
    const contexts = resolveBrowserContexts(await port.contexts(), input.target, now);
    if (!contexts.length) throw new Error("No browser context matched the target");
    for (const context of contexts) await port.reload(context.id, input.ignoreCache ?? false);
    return {
      type: "browser.effect.next",
      effectId,
      op: effect.op,
      contexts: contexts.map((context) => context.id),
    };
  } catch (error) {
    return {
      type: "browser.effect.error",
      effectId,
      op: effect.op,
      contexts: [],
      error: String(error),
    };
  }
}

export const chromeBrowserEffects: BrowserEffectsPort = {
  contexts: async () => (await chrome.tabs.query({})).flatMap((tab) =>
    tab.id === undefined || !tab.url
      ? []
      : [{
          id: tab.id,
          url: tab.url,
          active: tab.active,
          lastAccessed: tab.lastAccessed ?? 0,
        }],
  ),
  reload: async (contextId, ignoreCache) => {
    await chrome.tabs.reload(contextId, { bypassCache: ignoreCache });
  },
};
