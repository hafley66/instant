# proof-click lane brief

Repo: /Users/chrishafley/projects/instant-handoff. Package manager: pnpm (never
npm install; node_modules is already installed, install nothing). No commits,
no pushes. If reality deviates from this brief, STOP and report the deviation
in your final message; do not improvise.

Files you OWN (edit ONLY these two):
- src/plugins/harnessTrace/InTabStrip.tsx
- e2e/dock-strip-in-tab.spec.ts

## The change (user request, verbatim intent)
Single row click in the in-tab strip must stop opening things. Double-click is
the action: on a row WITH children it expands/collapses (the TreeTable already
does this by default via toggleOnDoubleClick); on a LEAF row it opens the
session (the current single-click body).

## InTabStrip.tsx
The TreeTable usage currently passes `onRowClick={onRowClick}` where onRowClick
calls openSession + termViewRouter.push. Replace it:
1. Remove the onRowClick prop from the TreeTable usage entirely (single click
   does nothing beyond the table's own selection).
2. Add `onRowDoubleClick={(r) => { if (!index.hasChildren(r.id)) onOpenRow(r); }}`
   where onOpenRow is the renamed current onRowClick body (openSession +
   termViewRouter.push, unchanged).
Keep the mail and kill buttons exactly as they are (their cells stop row
clicks already). Do not modify src/treetable.tsx.

## e2e/dock-strip-in-tab.spec.ts
1. The flow that clicks `laneRow.locator(".s-name").click()` and then expects
   "viewing: oc-lane": change the click to `.dblclick()`.
2. Directly BEFORE that dblclick, add the negative receipt: single-click the
   same locator, assert `page.getByText("viewing: oc-lane")` has count 0, and
   assert the opened() helper still returns null.
3. Any other single `.click()` on a session-name cell in this spec that
   expects a view push or an opened() value: change to `.dblclick()`. Twisty
   clicks (.tt-twisty), button clicks (mail, kill, scope, back) stay single.
Comments: at most 2 consecutive comment lines. No em dashes anywhere.

## Validation (run these, all must pass, paste tails in your final message)
- npx playwright test e2e/dock-strip-in-tab.spec.ts
- npx vitest run src/plugins/harnessTrace
- npx tsc --noEmit
