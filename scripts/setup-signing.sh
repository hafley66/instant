#!/bin/sh
# One-time: create a stable self-signed code-signing identity "Instant Dev" in
# the login keychain, so the dev linker shim (scripts/sign-link.sh) can give the
# instant binary a constant code-signature. macOS TCC keys Accessibility / Input
# Monitoring / Screen Recording on that signature, so the grants then survive
# `tauri dev` rebuilds instead of dropping every time the binary's hash changes.
#
# Run once:  just signing-setup   (or ./scripts/setup-signing.sh)
# You'll be asked for your login-keychain (login) password, and the first build
# after this pops one "codesign wants to use key" dialog — click "Always Allow".
set -eu

NAME="Instant Dev"
KC="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then
  echo "✓ '$NAME' code-signing identity already exists — nothing to do."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Creating self-signed code-signing cert '$NAME'…"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -subj "/CN=$NAME" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

openssl pkcs12 -export -out "$TMP/id.p12" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -passout pass: >/dev/null 2>&1

echo "Importing into the login keychain (may prompt for your keychain password)…"
security import "$TMP/id.p12" -k "$KC" -P "" -T /usr/bin/codesign

echo "Trusting it for code signing…"
security add-trusted-cert -d -r trustRoot -p codeSign -k "$KC" "$TMP/cert.pem" || \
  security add-trusted-cert -r trustRoot -p codeSign -k "$KC" "$TMP/cert.pem" || true

echo
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then
  echo "✓ '$NAME' is ready. Next:"
  echo "   1) Restart the app with:  just dev"
  echo "   2) On the first build, click 'Always Allow' on the codesign key prompt."
  echo "   3) Grant the binary once in System Settings → Privacy & Security →"
  echo "      Accessibility + Input Monitoring + Screen Recording."
  echo "   After that the grants persist across rebuilds."
else
  echo "⚠ identity not found after setup — see scripts/setup-signing.sh"
  exit 1
fi
