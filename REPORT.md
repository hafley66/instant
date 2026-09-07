# navmenu flip-hover

Submenus that overflow the right edge now flip so their right edge sits on the
owner's right edge (overlaying the parent) instead of to its left. A leaf row
no longer closes a deeper level when the pointer is inside it.

## Validation

### targeted tests

```
 RUN  v4.1.10 /Users/chrishafley/projects/instant/.boop-worktrees/fix/navmenu-flip-hover

 Test Files  2 passed (2)
      Tests  40 passed (40)
```

### tsc --noEmit

```
(no output; exited 0)
```

### full suite

```
 RUN  v4.1.10 /Users/chrishafley/projects/instant/.boop-worktrees/fix/navmenu-flip-hover

 Test Files  94 passed (94)
      Tests  564 passed (564)
```
