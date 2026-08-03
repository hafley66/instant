// Transport arg builders for the two bus legs, pure so scripts/bus.ts is a
// spawn and nothing else (2026-08-03 bus ruling: tmux is the injection
// transport, cass is the ack reader, no daemon and no receipt channel).
import type { IMailAgent, IMailCassHit, IMailLeg, IMailMessage } from "./0_types";

// The injected line carries the envelope id, which is what makes the ack query
// possible at all: cass can only prove a read by finding this text in the
// recipient's transcript.
export function injectedLine(message: IMailMessage): string {
  return `[bus ${message.id}] ${message.body}`;
}

export const MailLeg: IMailLeg = {
  tmuxSendArgs(agent, body, socket) {
    if (!agent.tmux) return null;
    const server = socket ? ["-L", socket] : [];
    // -l types the body literally: a body containing "Enter", ";" or "C-c" is
    // text, never a key name. The Enter is a separate call for the same reason.
    return [
      [...server, "send-keys", "-t", agent.tmux, "-l", "--", body],
      [...server, "send-keys", "-t", agent.tmux, "Enter"],
    ];
  },

  cassSearchArgs(message) {
    return ["search", message.id, "--robot", "--limit", "20"];
  },

  cassHits(agent, robotJson) {
    let value: unknown;
    try {
      value = JSON.parse(robotJson);
    } catch {
      return [];
    }
    if (typeof value !== "object" || value === null) return [];
    const hits = (value as { hits?: unknown }).hits;
    if (!Array.isArray(hits)) return [];
    const out: IMailCassHit[] = [];
    for (const raw of hits) {
      if (typeof raw !== "object" || raw === null) continue;
      const hit = raw as Record<string, unknown>;
      const sourcePath = typeof hit.source_path === "string" ? hit.source_path : "";
      if (!scopedToAgent(agent, sourcePath)) continue;
      out.push({
        source_path: sourcePath,
        workspace: typeof hit.workspace === "string" ? hit.workspace : "",
        agent: typeof hit.agent === "string" ? hit.agent : "",
        line_number: typeof hit.line_number === "number" ? hit.line_number : 0,
      });
    }
    return out;
  },
};

// A hit acks only inside the recipient's own transcript: the sender's session
// quotes the same id (it typed it), so an unscoped hit proves nothing.
function scopedToAgent(agent: IMailAgent, sourcePath: string): boolean {
  if (!sourcePath) return false;
  if (agent.sourcePath) return sourcePath === agent.sourcePath;
  if (!agent.sessionId) return false;
  return sourcePath.includes(agent.sessionId);
}
