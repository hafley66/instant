// Queue preview for one agent id: its in and out messages from the mailbox log,
// threaded by reply_to, with the ack state the 2026-08-03 bus ruling defines
// (to_timestamp filled only by a cass hit in this agent's transcript). Render
// only: every number on screen comes from MailStore's pure fold.
import { useCallback, useEffect, useMemo, useState } from "react";
import { relTime } from "../../core";
import { MailStore } from "./0_bus";
import { MAIL_DIR, MailboxReader } from "./2_mailbox";
import { claimStripFeed } from "./DockStripShared";
import type { IMailAgent, IMailMessage, IMailQueueRow } from "./0_types";

export interface MailPreviewProps {
  agentId: string;
  // Fixture injection for e2e/unit renders; absent = read the real mail dir.
  messages?: IMailMessage[];
  mailDir?: string;
}

const STYLE =
  ".mail-preview{display:flex;flex-direction:column;min-height:0}" +
  ".mail-preview .mp-dir{font-weight:bold}" +
  ".mail-preview .mp-body{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34ch}" +
  ".mail-preview .mp-ack{font-size:10px}" +
  ".mail-preview .mp-unacked{opacity:0.55}";

export function MailPreview({ agentId, messages, mailDir }: MailPreviewProps) {
  const [loaded, setLoaded] = useState<IMailMessage[]>([]);
  const [agent, setAgent] = useState<IMailAgent | null>(null);

  const load = useCallback(() => {
    if (messages) return;
    void MailboxReader.read(mailDir ?? MAIL_DIR).then((mailbox) => {
      setLoaded(mailbox.messages);
      setAgent(mailbox.directory[agentId] ?? null);
    });
  }, [agentId, mailDir, messages]);

  useEffect(() => {
    load();
    // Same single-owner feed the strips ride: an ack sweep lands without the
    // refresh button (fixture renders skip it, load is a no-op there anyway).
    if (messages) return;
    return claimStripFeed({ onMail: load, onLiveNames: () => {} });
  }, [load, messages]);

  const rows = useMemo(
    () => MailStore.queue(messages ?? loaded, agentId),
    [messages, loaded, agentId],
  );
  const unacked = rows.filter((row) => row.message.to_timestamp === null).length;

  return (
    <div className="v2-panel mail-preview" data-testid="mail-preview">
      <style>{STYLE}</style>
      <div className="act-bar">
        <span className="spy-title">mail · {agentId}</span>
        <span className="wt-count" data-testid="mail-count">
          {rows.length} messages · {unacked} unacked
        </span>
        <span className="spy-spacer" />
        {agent?.tmux ? <span className="s-meta">tmux {agent.tmux}</span> : null}
        {messages ? null : (
          <button type="button" onClick={load}>
            refresh
          </button>
        )}
      </div>
      <div className="panel-scroll">
        {rows.length === 0 ? (
          <div className="session-empty">no messages for {agentId}</div>
        ) : (
          <table className="dtable">
            <thead>
              <tr>
                <th />
                <th>kind</th>
                <th>peer</th>
                <th>body</th>
                <th>sent</th>
                <th>ack</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <QueueLine key={`${row.direction}:${row.message.id}`} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function QueueLine({ row }: { row: IMailQueueRow }) {
  const { message, direction, depth } = row;
  const acked = message.to_timestamp !== null;
  const peer = direction === "in" ? message.from : message.to;
  return (
    <tr
      className={"dtable-row" + (acked ? "" : " mp-unacked")}
      data-testid={"mail-row-" + message.id}
      title={message.body}
    >
      <td className="mp-dir">{direction === "in" ? "←" : "→"}</td>
      <td className="s-proc">{message.kind}</td>
      <td className="s-name">{peer}</td>
      <td>
        <span className="mp-body" style={{ paddingLeft: depth * 12 }}>
          {message.reply_to ? "↳ " : ""}
          {message.body.split("\n")[0]}
        </span>
      </td>
      <td className="s-meta" title={message.from_timestamp}>
        {relTime(Date.parse(message.from_timestamp) || 0)}
      </td>
      <td className="mp-ack" title={message.to_timestamp ?? "unacked"}>
        {acked ? "acked " + relTime(Date.parse(message.to_timestamp ?? "") || 0) : "queued"}
      </td>
    </tr>
  );
}
