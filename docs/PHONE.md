# Phone access: this session on the go

Goal: attach to the same tmux sessions instant renders, from Termux on Android,
over Tailscale, with local voice-to-text as the keyboard. No cloud anywhere.

## Mac side (one-time)

- [x] Tailscale up (`chriss-macbook-pro`, 100.109.164.53)
- [x] `brew install mosh` (mosh 1.4.0)
- [ ] Enable Remote Login (needs admin — pick one):
  - System Settings → General → Sharing → Remote Login → on, or
  - `sudo systemsetup -setremotelogin on`
  Restrict to your user; Tailscale already firewalls this to your tailnet
  (nothing listens on the public internet).
- mosh uses UDP 60000-61000 on top of ssh; over Tailscale no extra config.

## Phone side (Termux)

```sh
pkg install mosh openssh
# key once (password auth off is nicer):
ssh-keygen -t ed25519
ssh-copy-id chrishafley@chriss-macbook-pro   # or the 100.x address
# daily driver:
mosh chrishafley@chriss-macbook-pro -- tmux -L instant-prod attach
# or a phone-scoped session that instant also shows:
mosh chrishafley@chriss-macbook-pro -- tmux -L instant-prod new -A -s phone
```

mosh survives network flaps / phone sleep; tmux survives everything else.
Claude Code runs inside those sessions already. `/voice` does NOT work over
remote sessions (docs: mic must be local) — the phone-side voice keyboard is
the mic path.

## Termux ergonomics

- Extra-keys row (Esc/Ctrl/arrows — tmux needs them), in `~/.termux/termux.properties`:
  `extra-keys = [['ESC','TAB','CTRL','ALT','-','UP','|'],['~','/','HOME','LEFT','DOWN','RIGHT','END','PGUP']]`
  then `termux-reload-settings`.
- Font size: pinch, or Termux:Styling addon.

## Voice keyboard (phase 1) — verified 2026-07-03

Pick: **FUTO Keyboard** (built-in voice), v0.1.29.1+.
- whisper.cpp/GGML on-device; the APK has no INTERNET permission at all.
- The one candidate with a confirmed, shipped fix for the Termux voice-text
  duplication bug (futo-org/android-keyboard#1978, fixed 0.1.29, 2026-05-19)
  plus explicit Termux input-type detection in its IME code.
- Install via Obtainium from GitHub releases (or Play). License is FUTO
  Source First (source-available, not FOSS) — the one asterisk.
- Known cosmetic Termux issues: no copy/paste buttons (#780), suggestion bar
  shows in command mode (#888).

Runner-up: **Transcribro** (ISC FOSS, whisper.cpp+Silero VAD, Accrescent,
GrapheneOS's own recommendation) — but dormant since mid-2025, English-only,
and nobody has verified its Termux composing-text behavior. Re-evaluate at
Graphene time (GrapheneOS and FUTO have an adversarial history).

Avoid for Termux: HeliBoard + standalone FUTO Voice Input — the Termux fix
lives in FUTO Keyboard's own IME path, not the standalone injector. Sayboard
is Vosk-based (weaker on technical vocab/paths).

Sideload lockdown status (2026-07-03): enforcement starts 2026-09-30 in
Brazil/Indonesia/Singapore/Thailand only; US stock Pixels unaffected today.
GrapheneOS structurally exempt (not Play-certified) — permanent, not a
reprieve.

## Push to phone (phase 3)

ntfy: phone app subscribes to a private topic; anything can publish with
`curl -d "message" https://<server>/<topic>`. instant's rules engine
`action:"notify"` publishes rule matches to a configured ntfy URL (work
package in flight). Devops boxes curl the same topic directly.

## Later

- GrapheneOS (Pixel-only) when Google's sideload verification actually bites;
  Graphene is unaffected (own store, Accrescent, Obtainium).
- Tauri 2 has an Android target: a companion APK reusing this repo's frontend
  against the ingest server over Tailscale, if Termux stops being enough.
