// One live-spawn sample read through the panel's own join and tree, so the
// gate's assertions and the rendered page agree by construction. Pure: the
// sample already holds the bytes the driver read at that instant.
// Parent/child are identified by harness, never by name: the gate cwd holds
// exactly one claude session (the hailed pane) and one opencode session (what
// it spawned).
import { MailStore } from "./0_bus";
import { enrichRows, parseMailNdjson, parseMailRegistry } from "./0_mail";
import { indexAgentTree, toAgentNodes } from "./0_tree";
import type {
  ILiveSampleState,
  ILiveState,
  IMailMessage,
  MailEnvelope,
  MailRegistry,
} from "./0_types";

export const LiveState: ILiveState = {
  read(sample): ILiveSampleState {
    const envelopes: MailEnvelope[] = [];
    const messages: IMailMessage[] = [];
    let registry: MailRegistry = {};
    for (const [name, text] of Object.entries(sample.files)) {
      if (name === "registry.json") {
        registry = parseMailRegistry(text);
      } else if (name.endsWith(".ndjson")) {
        envelopes.push(...parseMailNdjson(text));
        messages.push(...MailStore.parse(text));
      }
    }
    const flat = enrichRows(sample.rows, envelopes, registry);
    const nodes = toAgentNodes(flat, envelopes, registry);
    const index = indexAgentTree(nodes);
    const parent = nodes.find((node) => node.harness === "claude") ?? null;
    const child = nodes.find((node) => node.harness === "opencode") ?? null;
    const folded = MailStore.fold(messages);
    return {
      at: sample.at,
      parentId: parent?.id ?? null,
      parentStatus: parent?.status ?? null,
      parentFrom: parent?.from ?? null,
      childId: child?.id ?? null,
      childStatus: child?.status ?? null,
      childParentId: child?.parentId ?? null,
      childParentKind: child?.parentKind ?? null,
      rootCount: index.roots.length,
      sessionCount: index.size,
      acked: folded.filter((message) => message.to_timestamp !== null).length,
      unacked: folded.filter((message) => message.to_timestamp === null).length,
    };
  },
};
