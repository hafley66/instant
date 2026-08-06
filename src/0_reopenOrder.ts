export type ReopenKind = "panel" | "terminal" | "none";

let closedOrder = 0;

export function nextClosedOrder(): number {
  closedOrder += 1;
  return closedOrder;
}

export function reopenKind(panelOrder: number | null, terminalOrder: number | null): ReopenKind {
  if (panelOrder == null && terminalOrder == null) return "none";
  if (panelOrder != null && panelOrder > (terminalOrder ?? -Infinity)) return "panel";
  return "terminal";
}
