#!/usr/bin/env bash
# Rendered by the release workflow and attached as instant-installer.sh. It
# installs the matching GitHub Release DMG into ~/Applications, clears the
# macOS quarantine attributes before first launch, and keeps the old app as a
# timestamped sibling until it is removed manually.
set -euo pipefail

release_tag="@RELEASE_TAG@"
release_version="@RELEASE_VERSION@"
case "$(uname -m)" in
  arm64) architecture="aarch64" ;;
  x86_64) architecture="x86_64" ;;
  *) echo "unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/instant-install.XXXXXX")"
mount_dir="$tmp_dir/mount"
mkdir "$mount_dir"
cleanup() {
  hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

dmg="$tmp_dir/instant.dmg"
url="https://github.com/hafley66/instant/releases/download/$release_tag/instant_${release_version}_${architecture}.dmg"
curl --fail --location --show-error --silent "$url" --output "$dmg"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_dir" -quiet

source_app="$mount_dir/instant.app"
target_dir="$HOME/Applications"
target_app="$target_dir/instant.app"
test -d "$source_app" || { echo "instant.app was not found in the release DMG" >&2; exit 1; }
mkdir -p "$target_dir"
if test -e "$target_app"; then
  backup="$target_dir/instant.app.$(date +%Y%m%d%H%M%S).backup"
  mv "$target_app" "$backup"
fi
ditto "$source_app" "$target_app"
xattr -cr "$target_app"
open "$target_app"
