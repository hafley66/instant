export type SequenceActor = {
  id: string;
  label: string;
  ordinal: number;
};

export type SequenceMessage = {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  ordinal: number;
  groupIds: string[];
};

export type SequenceGroup = {
  id: string;
  kind: string;
  label: string;
  ordinal: number;
  parentId?: string;
};

export type SequenceActivation = {
  id: string;
  actorId: string;
  ordinal: number;
};

export type SequenceModel = {
  language: "mermaid" | "d2";
  actors: SequenceActor[];
  messages: SequenceMessage[];
  groups: SequenceGroup[];
  activations: SequenceActivation[];
};

function cleanToken(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/^[+-]+|[+-]+$/g, "");
}

function cleanLabel(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, " ");
}

function actorId(token: string): string {
  return `actor/${cleanToken(token)}`;
}

function isSequenceArrow(value: string): boolean {
  return /[-.]+[<>]+|[<>]+[-.]+/.test(value);
}

function parseMessage(line: string): { source: string; target: string; label: string } | undefined {
  const match = line.match(/^\s*(\S+?)\s*([-.,<>+]+)\s*(\S+?)\s*:\s*(.*?)\s*$/);
  if (!match || !isSequenceArrow(match[2])) return undefined;
  return { source: cleanToken(match[1]), target: cleanToken(match[3]), label: cleanLabel(match[4]) };
}

function parseMermaidActor(line: string): { token: string; label: string } | undefined {
  const match = line.match(/^\s*(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+?))?\s*$/i);
  if (!match) return undefined;
  const token = cleanToken(match[1]);
  return { token, label: cleanLabel(match[2] ?? token) };
}

function parseGroupStart(line: string, language: "mermaid" | "d2"): { kind: string; label: string } | undefined {
  const mermaid = line.match(/^\s*(loop|alt|opt|par|critical|break|rect)\b\s*(.*?)\s*$/i);
  if (mermaid) return { kind: mermaid[1].toLowerCase(), label: cleanLabel(mermaid[2]) };
  if (language === "d2") {
    const d2 = line.match(/^\s*([^:{}]+?)\s*:\s*\{\s*$/);
    if (d2) return { kind: "d2-group", label: cleanLabel(d2[1]) };
  }
  return undefined;
}

function isGroupEnd(line: string, language: "mermaid" | "d2"): boolean {
  return language === "mermaid" ? /^\s*end\s*$/i.test(line) : /^\s*}\s*$/.test(line);
}

export function isSequenceDiagramSource(language: "mermaid" | "d2", source: string): boolean {
  return language === "mermaid"
    ? /^\s*sequenceDiagram\b/im.test(source)
    : /(^|\n)\s*shape\s*:\s*sequence_diagram\b/im.test(source);
}

export function parseSequenceSource(language: "mermaid" | "d2", source: string): SequenceModel {
  const actors: SequenceActor[] = [];
  const messages: SequenceMessage[] = [];
  const groups: SequenceGroup[] = [];
  const activations: SequenceActivation[] = [];
  const actorByToken = new Map<string, SequenceActor>();
  const groupStack: SequenceGroup[] = [];

  const ensureActor = (token: string, label = token): SequenceActor => {
    const cleaned = cleanToken(token);
    const existing = actorByToken.get(cleaned);
    if (existing) {
      if (existing.label === existing.id.slice("actor/".length) && label !== cleaned) existing.label = cleanLabel(label);
      return existing;
    }
    const actor = { id: actorId(cleaned), label: cleanLabel(label), ordinal: actors.length };
    actors.push(actor);
    actorByToken.set(cleaned, actor);
    return actor;
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("%%") || line.startsWith("#")) continue;
    if (isGroupEnd(line, language)) {
      groupStack.pop();
      continue;
    }
    const groupStart = parseGroupStart(line, language);
    if (groupStart) {
      const group: SequenceGroup = {
        id: `group/${groupStart.kind}/${groups.length}`,
        kind: groupStart.kind,
        label: groupStart.label || groupStart.kind,
        ordinal: groups.length,
      };
      const parentId = groupStack[groupStack.length - 1]?.id;
      if (parentId) group.parentId = parentId;
      groups.push(group);
      groupStack.push(group);
      continue;
    }
    const declaredActor = language === "mermaid" ? parseMermaidActor(line) : undefined;
    if (declaredActor) {
      ensureActor(declaredActor.token, declaredActor.label);
      continue;
    }
    const activation = language === "mermaid" ? line.match(/^\s*activate\s+(\S+)\s*$/i) : undefined;
    if (activation) {
      const actor = ensureActor(activation[1]);
      activations.push({ id: `activation/${activations.length}`, actorId: actor.id, ordinal: activations.length });
      continue;
    }
    if (language === "mermaid" && /^\s*deactivate\s+\S+\s*$/i.test(line)) continue;
    const message = parseMessage(line);
    if (!message) continue;
    const sourceActor = ensureActor(message.source);
    const targetActor = ensureActor(message.target);
    messages.push({
      id: `message/${messages.length}`,
      sourceId: sourceActor.id,
      targetId: targetActor.id,
      label: message.label,
      ordinal: messages.length,
      groupIds: groupStack.map((group) => group.id),
    });
  }

  return { language, actors, messages, groups, activations };
}

function normalText(value: string | null): string {
  return cleanLabel(value ?? "").toLowerCase();
}

function markElement(element: Element, message: SequenceMessage, role: string): void {
  element.setAttribute("data-sequence-entity", message.id);
  element.setAttribute("data-sequence-role", role);
  element.setAttribute("data-sequence-actors", `${message.sourceId},${message.targetId}`);
  if (message.groupIds.length) element.setAttribute("data-sequence-groups", message.groupIds.join(" "));
}

function decodedD2Owner(element: Element): string {
  const owner = element.parentElement?.getAttribute("class")?.split(/\s+/)[0];
  if (!owner || typeof atob === "undefined") return "";
  try {
    return atob(owner);
  } catch {
    return "";
  }
}

function markMermaidMirrorActor(root: Element, actor: SequenceActor): void {
  const token = actor.id.slice("actor/".length);
  for (const group of root.querySelectorAll<SVGGElement>("g")) {
    const directActor = group.classList.contains("actor-bottom") && cleanToken(group.getAttribute("name") ?? "") === token;
    const participantBox = Array.from(group.children).some((child) =>
      child.classList.contains("actor-bottom") && cleanToken(child.getAttribute("name") ?? "") === token);
    if (directActor || participantBox) group.setAttribute("data-sequence-mirrored", "true");
  }
}

function decorateSequenceRoot(root: Element, model: SequenceModel): void {
  root.setAttribute("data-sequence-diagram", "true");
  root.setAttribute("data-sequence-language", model.language);
  root.setAttribute("data-sequence-actor-ids", model.actors.map((actor) => actor.id).join(" "));
  root.setAttribute("data-sequence-group-ids", model.groups.map((group) => group.id).join(" "));

  const textNodes = Array.from(root.querySelectorAll("text"));
  const unusedTextNodes = new Set(textNodes);
  for (const actor of model.actors) {
    const token = actor.id.slice("actor/".length);
    const textNode = model.language === "mermaid"
      ? Array.from(root.querySelectorAll<SVGTextElement>('g[data-et="participant"][data-id] text'))
        .find((node) => cleanToken(node.closest("g[data-et='participant']")?.getAttribute("data-id") ?? "") === token
          && normalText(node.textContent) === normalText(actor.label))
      : textNodes.find((node) => unusedTextNodes.has(node) && normalText(node.textContent) === normalText(actor.label));
    if (!textNode) continue;
    unusedTextNodes.delete(textNode);
    textNode.setAttribute("data-sequence-entity", actor.id);
    textNode.setAttribute("data-sequence-role", "actor-label");
    textNode.setAttribute("data-sequence-actors", actor.id);
    textNode.setAttribute("data-sequence-actor-id", actor.id);
    if (model.language === "mermaid") markMermaidMirrorActor(root, actor);
  }

  const candidates = Array.from(root.querySelectorAll("[class*='messageLine'], [class~='connection']"));
  const messageNodes = candidates.filter((element, index) => candidates.indexOf(element) === index && element.tagName.toLowerCase() !== "g");
  const sequenceMessageNodes = model.language === "d2"
    ? messageNodes.filter((element) => /(?:->|<-|&gt;|&lt;)/.test(decodedD2Owner(element)))
    : messageNodes;
  for (const [index, element] of sequenceMessageNodes.entries()) {
    const message = model.messages[index];
    if (message) markElement(element, message, "message");
  }

  const messageTextNodes = textNodes.filter((node) => (node.getAttribute("class") ?? "").includes("messageText"));
  for (const [index, element] of messageTextNodes.entries()) {
    const message = model.messages[index];
    if (message) markElement(element, message, "message-label");
  }

  const activationNodes = Array.from(root.querySelectorAll("[class*='activation']"))
    .filter((element) => element.tagName.toLowerCase() !== "g");
  for (const [index, element] of activationNodes.entries()) {
    const activation = model.activations[index];
    const actor = model.actors.find((candidate) => candidate.id === activation?.actorId);
    if (!activation || !actor) continue;
    element.setAttribute("data-sequence-entity", activation.id);
    element.setAttribute("data-sequence-role", "activation");
    element.setAttribute("data-sequence-actors", actor.id);
  }
}

export function decorateSequenceSvg(svg: string, model: SequenceModel): string {
  if (!svg || typeof DOMParser === "undefined") return svg;
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return svg;
  decorateSequenceRoot(root, model);
  return new XMLSerializer().serializeToString(root);
}

export function sequenceMarkup(svg: string, language: "mermaid" | "d2", source: string): string {
  const model = parseSequenceSource(language, source);
  if (!isSequenceDiagramSource(language, source) || (model.actors.length === 0 && model.messages.length === 0)) return svg;
  return decorateSequenceSvg(svg, model);
}

export function sequenceFocusFromElement(element: Element): { entityId?: string; actorIds: string[] } {
  const entityId = element.getAttribute("data-sequence-entity") ?? undefined;
  const actorIds = (element.getAttribute("data-sequence-actors") ?? "").split(",").filter(Boolean);
  return { entityId, actorIds };
}
