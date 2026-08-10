#!/bin/bash
# Build and install Instant with the shared local "Instant Dev" identity.
# Optional first argument: exported Instant Dev.p12 from the other Mac.
set -euo pipefail

SIGNING_NAME="Instant Dev"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
P12_PATH="${1:-}"
APP_NAME="$(node -p "require('$REPO_ROOT/src-tauri/tauri.conf.json').productName")"
BUILT_APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
INSTALLED_APP="/Applications/$APP_NAME.app"

if [ -n "$P12_PATH" ]; then
  P12_PATH="$(cd "$(dirname "$P12_PATH")" && pwd)/$(basename "$P12_PATH")"
  if [ ! -f "$P12_PATH" ]; then
    echo "missing identity file: $P12_PATH" >&2
    exit 1
  fi
  read -r -s -p "Password for $(basename "$P12_PATH"): " P12_PASSWORD
  echo
  security import "$P12_PATH" \
    -k "$LOGIN_KEYCHAIN" \
    -P "$P12_PASSWORD" \
    -T /usr/bin/codesign
  unset P12_PASSWORD
  CERT_PEM="$(mktemp -t instant-dev-cert).pem"
  trap 'rm -f "$CERT_PEM"' EXIT
  security find-certificate -c "$SIGNING_NAME" -p "$LOGIN_KEYCHAIN" > "$CERT_PEM"
  security add-trusted-cert -d -r trustRoot -p codeSign -k "$LOGIN_KEYCHAIN" "$CERT_PEM"
fi

if ! security find-identity -v -p codesigning "$LOGIN_KEYCHAIN" | grep -Fq "\"$SIGNING_NAME\""; then
  echo "missing '$SIGNING_NAME' signing identity" >&2
  echo "source Mac: just signing-setup, then export Instant Dev from Keychain Access > My Certificates" >&2
  echo "work Mac: just install-local '/path/to/Instant Dev.p12'" >&2
  exit 1
fi

signing_requirement() {
  codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p'
}

old_requirement=""
if [ -d "$INSTALLED_APP" ]; then
  old_requirement="$(signing_requirement "$INSTALLED_APP" || true)"
fi

cd "$REPO_ROOT"
corepack pnpm@10.12.4 tauri build \
  --bundles app \
  --config '{"bundle":{"macOS":{"signingIdentity":"Instant Dev"}}}'

codesign --verify --deep --strict --verbose=4 "$BUILT_APP"
new_requirement="$(signing_requirement "$BUILT_APP")"
if [ -z "$new_requirement" ]; then
  echo "built app has no designated signing requirement" >&2
  exit 1
fi

pkill -x "$APP_NAME" 2>/dev/null || true
ditto "$BUILT_APP" "$INSTALLED_APP"

if [ -n "$old_requirement" ] && [ "$old_requirement" != "$new_requirement" ]; then
  echo "signing requirement changed; resetting old TCC grants once"
  tccutil reset Accessibility com.instant.summon || true
  tccutil reset ListenEvent com.instant.summon || true
  tccutil reset ScreenCapture com.instant.summon || true
fi

echo
echo "installed: $INSTALLED_APP"
codesign -dvv "$INSTALLED_APP" 2>&1 | grep -E '^(Identifier|Authority|Signature)=' || true
echo
echo "Enable Instant in Accessibility and Input Monitoring, then relaunch it."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
open "$INSTALLED_APP"
