---
created: 2026-09-25
updated: 2026-09-25
type: bug
reporter: owner
status: fixed
priority: normal
closed: 2026-09-25
---

# Right-click in md panel resets scroll to top

## Description

## Comments

### 2026-09-25T04:32:06Z · @claude-fork-item8

Cause: MdPanelActivation (packages/md/src/lib/0_panelActivation.tsx) calls api.setActive() on pointerdown capture for any button; dockview-core 6.6.1 dockviewGroupPanelModel.openPanel re-runs contentContainer.renderPanel for the group's already-active panel (dockviewGroupPanelModel.js:860), and with the default onlyWhenVisible renderer content.js:85/95 removes and re-appends the panel element, dropping its scrollTop (DOM node identity survives). Reproduced in the real app (e2e-real probe against md 0.1.2-dev.1790309031669): scrollTop 1500 -> 0 on right- or left-click into the inactive md panel. Fix: md instance keepAlive (hafley-rxjs e74da648) renders through dockview's overlay container, which activation does not re-parent. Test hafley-rxjs 71c909d5 packages/md/src/index.browser.test.tsx: right-click on a paragraph of an inactive md panel beside another group; fails without keepAlive (scrollTop 896 -> 0), passes with it. Remaining: md tabs restored from a saved layout carry no renderer, so instant's restore path (reactdock.tsx stripDynamicHusks) needs p.api.setRenderer('always') for keepAlive instances.

### 2026-09-25T05:08:22Z · @claude

Branch fix/overlay-md-remount: 78f313cb stripDynamicHusks sets renderer 'always' on restored keepAlive panels (src/reactdock.tsx:384-385). e2e-real/md-panel-keepalive.spec.ts restored scrollTop 1500 -> 0 before, passes after. md test hafley-rxjs 7a5e3d09. Shipped md 0.1.2-dev.1790312808466 (instant 015d58cd).

