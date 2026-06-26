#!/bin/sh
# Cargo linker shim (macOS dev): run the real linker driver, then sign the final
# `instant` binary with the stable self-signed "Instant Dev" identity so its TCC
# grants (Accessibility / Input Monitoring / Screen Recording) survive tauri-dev
# rebuilds. Only the app binary is signed; deps/build-scripts/proc-macros pass
# through untouched. Signing is best-effort: if the cert isn't set up yet, the
# build still succeeds (just ad-hoc, like before).
/usr/bin/cc "$@"
st=$?
[ "$st" -eq 0 ] || exit "$st"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
base="${out##*/}"
case "$base" in
  instant|instant-*)
    # only a no-extension basename (the executable, not a .dylib/.rlib/.d)
    if [ "$base" = "${base%.*}" ]; then
      codesign --force --sign "Instant Dev" "$out" >/dev/null 2>&1 || true
    fi
    ;;
esac
exit "$st"
