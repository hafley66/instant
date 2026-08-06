import type { AiMessage } from "./state";

export type MessageDiagram = {
  messageId: string;
  locator: string;
  language: "mermaid" | "d2";
  code: string;
};

export function diagramsFromMessageTail(messages: AiMessage[], tail = 30): MessageDiagram[] {
  return messages
    .filter((message) => message.role === "assistant" && message.subtype == null)
    .slice(-tail)
    .flatMap((message) => {
      const diagrams: MessageDiagram[] = [];
      const fences = /(?:^|\n)\s*(`{3,}|~{3,})\s*(mermaid|d2)\s*\n([\s\S]*?)\n\s*\1\s*(?=\n|$)/gi;
      for (const match of message.text.matchAll(fences)) {
        diagrams.push({
          messageId: message.id,
          locator: message.locator,
          language: match[2].toLowerCase() as MessageDiagram["language"],
          code: match[3].trimEnd(),
        });
      }
      return diagrams;
    });
}

export function normalizedDiagramLines(code: string): string[] {
  return code
    .split("\n")
    .map((line) => line.toLowerCase().replace(/^\s*[•●]\s?/, "").replace(/\s+/g, " ").trim())
    .filter((line) => /[a-z0-9]/.test(line) && line.length >= 4);
}

export function isGenericMermaidDeclaration(line: string): boolean {
  return /^(?:flowchart|graph)(?:\s+(?:tb|td|bt|rl|lr))?$/i.test(line)
    || /^(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|sankey-beta|xychart-beta)$/i.test(line);
}
