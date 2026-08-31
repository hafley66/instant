#!/usr/bin/env bash
# release.yml on this machine (runner outage path): pinned worktrees, both targets, upload.
set -euo pipefail

cd "$(dirname "$0")/.."

tag="${1:-$(git describe --tags --abbrev=0)}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "usage: scripts/2_release_local.sh [vX.Y.Z] (default: newest tag)"
  exit 1
}
version="${tag#v}"
git rev-parse "$tag" >/dev/null 2>&1 || { echo "no tag $tag"; exit 1; }

rev="$(git show "$tag:hafley-rs.rev" | tr -d '[:space:]')"
[[ -n "$rev" ]] || { echo "tag $tag carries no hafley-rs.rev"; exit 1; }

hafley_rs="$(cd .. && pwd)/hafley-rs"
[[ -d "$hafley_rs/.git" ]] || { echo "no hafley-rs checkout at $hafley_rs"; exit 1; }

build_root="$(mktemp -d "${TMPDIR:-/tmp}/instant-release.XXXXXX")"
cleanup() {
  git worktree remove --force "$build_root/instant" 2>/dev/null || true
  git -C "$hafley_rs" worktree remove --force "$build_root/hafley-rs" 2>/dev/null || true
  rm -rf "$build_root"
}
trap cleanup EXIT

git worktree add "$build_root/instant" "$tag"
git -C "$hafley_rs" worktree add --detach "$build_root/hafley-rs" "$rev"

cd "$build_root/instant"
corepack pnpm@10.12.4 install --frozen-lockfile

test "$(node -p 'require("./package.json").version')" = "$version"
grep -qx "version = \"$version\"" src-tauri/Cargo.toml
grep -qx "  \"version\": \"$version\"," src-tauri/tauri.conf.json

assets=()
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  arch="${target%%-*}"
  rustup target add "$target"
  # tauri's own dmg bundler drives Finder through AppleScript and dies in a
  # headless shell, so bundle only the .app and press the dmg with hdiutil.
  corepack pnpm@10.12.4 tauri build --target "$target" --bundles app
  bundle="src-tauri/target/$target/release/bundle"
  stage="$bundle/dmg-stage"
  dmg="$bundle/dmg/instant_${version}_${arch}.dmg"
  rm -rf "$stage"
  mkdir -p "$stage" "$bundle/dmg"
  cp -R "$bundle/macos/instant.app" "$stage/"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname instant -srcfolder "$stage" -ov -format UDZO "$dmg"
  assets+=("$PWD/$dmg")
done

installer="$build_root/instant-installer.sh"
sed \
  -e "s/@RELEASE_TAG@/$tag/g" \
  -e "s/@RELEASE_VERSION@/$version/g" \
  scripts/1_install.sh > "$installer"
chmod +x "$installer"

gh release view "$tag" >/dev/null 2>&1 || \
  gh release create "$tag" --generate-notes --title "$tag"
gh release upload "$tag" --clobber "${assets[@]}" "$installer#instant-installer.sh"

gh release view "$tag" --json assets -q '.assets[].name'
echo "done; a still-queued CI run for $tag is now redundant: gh run list --workflow=release.yml"
