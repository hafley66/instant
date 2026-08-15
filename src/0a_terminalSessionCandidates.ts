import type { HarnessId } from "./harnessTypes";

export type ResolvedSession = { editor: HarnessId; sessionId: string; cwd: string };

export function boundSessionFirst(
  sessions: ResolvedSession[],
  cwds: string[],
  bound: { editor: HarnessId; sessionId: string } | undefined,
): ResolvedSession[] {
  if (!bound) return sessions;
  const key = `${bound.editor}:${bound.sessionId}`;
  return [
    ...cwds.map((cwd) => ({ ...bound, cwd })),
    ...sessions.filter((session) => `${session.editor}:${session.sessionId}` !== key),
  ];
}
