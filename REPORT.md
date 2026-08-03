# REPORT: quote-aware hover links (paths with spaces)

Worktree `/Users/chrishafley/projects/instant-lab-quotelink`, branch `lab/quotelink`.
`git merge --ff-only a35ad6a` -> "Already up to date." (clean no-op, HEAD was
already a35ad6a). Deps installed with `corepack pnpm@10.12.4 install --prefer-offline`
("Done in 8.2s"): the worktree had no node_modules. No subagents, no push,
nothing written outside the worktree.

Commits:

| sha | what |
|---|---|
| a6225e3 | fail-first fixtures (red: 5 failures) |
| ebb6545 | scanner fix (green: 39/39) |

## verified-hypothesis

Instrumented with a throwaway `src/__probe.test.ts` (deleted before the red
commit) that dumped `scanLineTokens` spans + the `looksOpenable` verdict for
each candidate shape. Run at base a35ad6a. Raw output:

```
### H1a exact contract elision
line: "'/var/folders/.../Screenshot 2026-08-03 at 10.05.13 AM.png'"
  [  1, 58) openable=true "/var/folders/.../Screenshot 2026-08-03 at 10.05.13 AM.png"

### H1b realistic full path
line: "'/var/folders/3k/qz9_8x0d1_v0000gn/T/TemporaryItems/NSIRD_screencaptureui_9Kq2Zt/Screenshot 2026-08-03 at 10.05.13 AM.png'"
  [  1,121) openable=true "/var/folders/3k/.../Screenshot 2026-08-03 at 10.05.13 AM.png"

### H1c leading prose
line: "read '/var/folders/3k/.../Screenshot 2026-08-03 at 10.05.13 AM.png' please"
  [  0,  4) openable=false "read"
  [  6,126) openable=true "/var/folders/3k/.../Screenshot 2026-08-03 at 10.05.13 AM.png"
  [128,134) openable=false "please"

### H1d truncated at row end (unpaired opener)
line: "'/var/folders/3k/.../Screenshot 2026"
  [  1, 91) openable=true "/var/folders/3k/.../Screenshot"
  [ 92, 96) openable=false "2026"

### H2a
line: "reading claude's log at '/a b/c.png'"
  [  0,  7) openable=false "reading"
  [  8, 16) openable=false "claude's"
  [ 15, 24) openable=false "s log at "
  [ 28, 35) openable=true "b/c.png"

### H2b
line: "don't open '/tmp/my shots/a b.png' yet"
  [  0,  5) openable=false "don't"
  [  4, 11) openable=false "t open "
  [ 20, 27) openable=true "shots/a"
  [ 28, 33) openable=true "b.png"
  [ 35, 38) openable=false "yet"

### H3 joined wrapped rows (isWrapped set), quote pair present
joined: "'/var/folders/3k/.../Screenshot 2026-08-03 at 10.05.13 AM.png'"
[{"text":"/var/folders/3k/.../Screenshot 2026-08-03 at 10.05.13 AM.png",
  "ranges":[{"rowIndex":0,"startCol":1,"endCol":61},
            {"rowIndex":1,"startCol":0,"endCol":60}]}]

### H4 single row, no wrap flag
[{"text":"/var/folders/3k/qz9_8x0d1_v0000gn/T/TemporaryItems/NSIRD_scr",
  "ranges":[{"rowIndex":0,"startCol":1,"endCol":61}]}]
```

### Deviation from the contract's framing

The contract's screenshot signature ("underline starts at `/`, not at `'`") does
NOT discriminate. A correctly-paired quoted span is `[open+1, close)` by design:
it excludes the quotes, so it also starts at `/`. H1a/H1b/H1c/H3 show the
**paired** case already worked at base -- the exact contract line, the same line
with prose either side, and the same line hard-wrapped across two rows all
produced one full span at base, pre-fix. Those four are now regression guards,
not fixes.

What discriminates is the underline **stopping at the first space**. Two shapes
produce that, and only two:

| # | shape | verdict |
|---|---|---|
| 1 | unpaired opener (H1d/H4): the closing quote is not in the joined line | CONFIRMED as a symptom producer. Not fixable from the scanner -- see below. |
| 2 | apostrophe false-pair (H2a/H2b) | CONFIRMED, and worse than the contract described. |

Hypothesis 2 was under-stated. The `(['"`])(.+?)\1` matchAll does not merely
"destroy the real span", it does three things at once:

- `claude's` -> the apostrophe opens a region that closes on the real path's
  OPENING quote, emitting the junk span `"s log at "`.
- that junk span's `close` sits before `/a`, so the suppression test
  `at >= q.open && at <= q.close` does not fire and the fragments `b/c.png`,
  `shots/a`, `b.png` are emitted as **openable** links. The user gets an
  underline on a path fragment that resolves to nothing.
- the spans **overlap**: `claude's` is `[8,16)` and `"s log at "` is `[15,24)`.
  `tokenAtColumn` uses `.find()`, so column 15 answers `claude's` while the
  link provider draws two overlapping xterm ranges over the same cell. The
  existing "produces non-overlapping spans in column order" test never had an
  apostrophe fixture, so this invariant was already violated at base.

Hypothesis 3 (hover card disagreeing with the underline) is FALSE: `wordAt`
(terminal.ts:367-383) and `wrappedLinkSpans` (termWrapJoin.ts:83-91) both go
through `scanLineTokens` over the same joined line, so they drift together, in
both directions. No separate fix needed; the scanner fix moves all three call
sites at once.

Hypothesis 1's *premise* (that the Claude Code TUI composer writes each visual
row as its own hard line with no `isWrapped` flag) was NOT verifiable from this
worktree -- it needs a live TUI in a real xterm buffer, and the lab has no such
harness. What H4 does verify is the scanner's behavior GIVEN that input: a
single row carrying only an opener yields a truncated, `looksOpenable`-passing
token. H3 verifies the contrary case: with `isWrapped` set, the join already
delivers the whole quoted path today.

## fix summary

`src/termTokens.ts`, one function added and one changed. Both call sites
(link provider, hover card) inherit it; nothing outside the scanner moved,
per the module's header law.

`quotedRegions(line)` replaces the `(['"`])(.+?)\1` matchAll. A quote character
delimits a region only where its neighbours agree:

- opener: at line start, or preceded by one of `` [\s([{<=:,'"`] ``
- closer: at line end, or followed by one of `` [\s)\]}>.,;:!?'"`] ``

so `claude's`, `don't` and `agents'` cannot open a region, while
`path='/a b.png'`, `` see `src/a.ts`, `` and `"'/a b/c.png'"` still pair.
Regions are scanned left to right, never nest, never overlap (the loop jumps
`i` to the closer).

Second change: a whitespace run is now suppressed when it **overlaps** a region
(`at <= q.close && at + run.length > q.open`), not only when it starts inside
one. Without this `path='/a b.png'` is a single `\S+` run spanning the whole
region and emits a span overlapping the quoted one.

## fixtures added

`src/termTokens.test.ts`, new `describe("quote pairing")`, 7 cases. `SHOT` is
the exact screenshot path (macOS
`/var/folders/.../T/TemporaryItems/NSIRD_screencaptureui_*/Screenshot 2026-08-03 at 10.05.13 AM.png`).

| fixture | pre-fix |
|---|---|
| links the whole quoted screenshot path | PASS (guard) |
| links the quoted screenshot path with prose on both sides | PASS (guard) |
| does not let a possessive apostrophe open a span (`reading claude's log at '/a b/c.png'`, asserts the underline too) | FAIL |
| does not let a contraction apostrophe open a span (`don't open '/tmp/my shots/a b.png' yet`) | FAIL |
| keeps spans non-overlapping on apostrophe prose (4 lines, plus every span slices back to its own text) | FAIL |
| pairs a quote opened right after an assignment or bracket (`path='...'`, `` see `src/main.ts`, ok ``) | FAIL |
| leaves an unpaired opening quote to the whitespace-run fallback | PASS (guard against the naive fix) |

`src/termWrapJoin.test.ts`, 2 added to `describe("wrappedLinkSpans")`:

| fixture | pre-fix |
|---|---|
| emits one link for a quoted path whose spaces straddle a wrap (asserts both row ranges) | PASS (guard) |
| keeps a wrapped quoted path whole when prose above it holds an apostrophe | FAIL |

Fail-first receipt, at a6225e3 (scanner still at base):

```
 x src/termWrapJoin.test.ts (13 tests | 1 failed) 8ms
     x keeps a wrapped quoted path whole when prose above it holds an apostrophe 4ms
 x src/termTokens.test.ts (26 tests | 4 failed) 12ms
     x does not let a possessive apostrophe open a span 4ms
     x does not let a contraction apostrophe open a span 0ms
     x keeps spans non-overlapping on apostrophe prose 0ms
     x pairs a quote opened right after an assignment or bracket 1ms

 Test Files  2 failed (2)
      Tests  5 failed | 34 passed (39)
```

## gate outputs

`npx tsc --noEmit`:

```
src/plugin.test.ts(69,64): error TS2339: Property 'label' does not exist on type 'CtxItem'.
  Property 'label' does not exist on type '{ sep: true; }'.
```

PRE-EXISTING. Reproduced byte-identical on a detached checkout of a35ad6a.
`src/plugin.test.ts` is untouched by this lab. Left alone (out of scope).

`npx vitest run src/termTokens.test.ts src/termWrapJoin.test.ts`:

```
 Test Files  2 passed (2)
      Tests  39 passed (39)
   Duration  122ms
```

`npx vitest run` (full):

```
 x src/panelZoom.test.ts (6 tests | 4 failed) 893ms
     x defaults to 1x and remembers a set factor
     x clamps to the kind's bounds
     x fires onZoom with the applied factor; reset restores 1x
     x gestures step the resolved target by the kind's step
ReferenceError: Cannot access 'kinds' before initialization
 -> registerZoomKind src/panelZoom.ts:24:3
 -> src/terminal.ts:282:1
 -> src/favorites.ts:12:1

 Test Files  1 failed | 41 passed (42)
      Tests  4 failed | 273 passed (277)
```

PRE-EXISTING. At a35ad6a the same run gives `4 failed | 264 passed (268)` with
the same four names and the same `ReferenceError`: a circular import
(`favorites.ts` -> `terminal.ts` -> `registerZoomKind` before `panelZoom.ts`'s
`kinds` initializer runs). None of those three files is touched by this lab.
Delta from base is +9 passing, +0 failing.

`npx playwright test e2e/term-cmd-hover.spec.ts e2e/term-wrap-hover.spec.ts`
(both existing specs cover link hover; no new e2e infra built):

```
Running 10 tests using 2 workers
  ok   2 e2e/term-cmd-hover.spec.ts:53:1 > hover on Update(src/main.ts) names the path, not the call envelope (1.3s)
  ok   1 e2e/term-wrap-hover.spec.ts:59:1 > hover on either wrapped row names the whole path (1.4s)
  ok   3 e2e/term-cmd-hover.spec.ts:65:1 > hover over the envelope itself offers nothing (907ms)
  ok   4 e2e/term-wrap-hover.spec.ts:74:1 > hover on the wrapped path resolves to the real file (858ms)
  ok   5 e2e/term-cmd-hover.spec.ts:83:1 > hover keeps a line suffix and resolves it (823ms)
  ok   6 e2e/term-wrap-hover.spec.ts:83:1 > click on the wrapped continuation dispatches the whole path (873ms)
  ok   7 e2e/term-cmd-hover.spec.ts:93:1 > a bare filename that matches several files reports the ambiguity (745ms)
  ok   8 e2e/term-wrap-hover.spec.ts:97:1 > wrapped hover card snapshot (869ms)
  ok   9 e2e/term-cmd-hover.spec.ts:104:1 > click on a resolved file opens it in a preview tab (768ms)
  ok  10 e2e/term-cmd-hover.spec.ts:119:1 > hover card snapshot (826ms)

  10 passed (7.1s)
```

Both card snapshots still match, so the fix did not move any span the e2e
harness draws.

Extra sanity sweep (throwaway, not committed) over real terminal shapes, all
correct after the fix:

```
"error: pathspec 'src/main.ts' did not match" -> ["error","pathspec","src/main.ts","did","not","match"]
"it's fine, see src/main.ts"                  -> ["it's","fine","see","src/main.ts"]
"Bob's file is at /tmp/a.png"                 -> ["Bob's","file","is","at","/tmp/a.png"]
"rm -rf \"/tmp/my dir\""                      -> ["rm","-rf","/tmp/my dir"]
"git commit -m \"fix src/a.ts\""              -> ["git","commit","-m","fix src/a.ts"]
"you can't have 'a' and \"b\""                -> ["you","can't","have","a","and","b"]
"`src/a.ts` and `src/b.ts`"                   -> ["src/a.ts","and","src/b.ts"]
"python -c 'import os; print(os.path)'"       -> ["python","-c","import os; print(os.path)"]
"cd ~/projects/sprefa && ls"                  -> ["cd","~/projects/sprefa","&&","ls"]
"  L  Read src/termTokens.ts (129 lines)"     -> ["L","Read","src/termTokens.ts","129","lines"]
```

## unpaired-quote decision

**Left alone**, deliberately, with a fixture pinning today's behavior.

`quotedRegions` emits nothing for an opener with no closer, so the `\S+`
fallback still yields `/tmp/shots/Screenshot`, `2026-08-03`, `at`, `10` for
`'/tmp/shots/Screenshot 2026-08-03 at 10`. Identical to base. Zero regression.

Why no fix is available from the scanner:

1. **The information is not in the input.** The scanner is handed the joined
   logical line. If the composer writes each visual row as its own hard line
   with no `isWrapped` flag, the closing quote is not in that string at all --
   not truncated, absent. No rule over the given characters can recover where
   the path ended. `wrappedLineRows` (terminal.ts:333-359) walks xterm's
   `isWrapped` flags and nothing else; there is no second source to consult.

2. **The tempting fix is the one the contract forbids.** "Unpaired opener ->
   run the region to end of line" would dispatch
   `/tmp/shots/Screenshot 2026-08-03 at 10` -- a truncated multi-word path
   presented as a complete file name. That is strictly worse than today: the
   current truncation at least stops at a token boundary, and `refResolve`'s
   bare-name search can still find a same-named file, whereas a path with a
   half-eaten timestamp in it can only miss. The added fixture "leaves an
   unpaired opening quote to the whitespace-run fallback" exists to fail if a
   later change reaches for that.

3. **Suppression would be a regression.** Blanking every `\S+` span after an
   unpaired opener kills `he said 'go read src/main.ts` -- a real prose shape
   that links correctly today. The contract's "no regression vs today" rules
   it out.

If this case is worth closing later, the fix belongs one layer down, in
`wrappedLineRows`, not in the scanner: detect a TUI composer box (the row is
fenced by box-drawing glyphs) and stitch its rows into one logical line the way
`isWrapped` rows are stitched, stripping the fence glyphs and adjusting
`rowStartOffsets`. That is a terminal-buffer change with its own e2e surface,
outside this contract's scope.

## adjacent issue observed, not fixed

A quoted region's inner text bypasses `unwrapToken`, so `"Update(src/a.ts)"`
emits the raw `Update(src/a.ts)` -- envelope included -- which `looksOpenable`
passes. Pre-existing at base, unrelated to the quote-pairing defect, and
routing quoted inner text through `unwrapToken` would break `'q p.md'`-style
paths whose own punctuation is meaningful. Flagged, not touched.
