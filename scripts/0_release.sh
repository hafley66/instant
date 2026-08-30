#!/usr/bin/env bash
# Make the three package manifests agree, commit that release, and create the
# tag that invokes .github/workflows/release.yml. GitHub builds the source tree
# and attaches the resulting DMGs to that tag's release.
set -euo pipefail

cd "$(dirname "$0")/.."

version="${1:?usage: scripts/0_release.sh X.Y.Z}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "version must be X.Y.Z, got '$version'"
  exit 1
}

tag="v$version"
git rev-parse "$tag" >/dev/null 2>&1 && {
  echo "tag $tag already exists"
  exit 1
}

# CI has no sibling hafley-rs checkout, so release.yml clones one at this
# revision. Recording it here keeps a tag's bundle reproducible.
hafley_rs="$(cd .. && pwd)/hafley-rs"
[[ -d "$hafley_rs/.git" ]] || {
  echo "no hafley-rs checkout at $hafley_rs"
  exit 1
}
git -C "$hafley_rs" fetch -q origin main
rev="$(git -C "$hafley_rs" rev-parse HEAD)"
git -C "$hafley_rs" merge-base --is-ancestor "$rev" origin/main || {
  echo "hafley-rs $rev is not on origin/main; push hafley-rs before releasing"
  exit 1
}
dirty="$(git -C "$hafley_rs" status --porcelain -- crates)"
[[ -z "$dirty" ]] || echo "warning: hafley-rs has uncommitted crate changes the bundle will not carry:"$'\n'"$dirty"
echo "$rev" > hafley-rs.rev

perl -0pi -e "s/(\"version\": \")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/" package.json
perl -0pi -e "s/^(version = \")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/m" src-tauri/Cargo.toml
perl -0pi -e "s/(\"version\": \")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/" src-tauri/tauri.conf.json
perl -0pi -e "s/(name = \"instant\"\nversion = \")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/" src-tauri/Cargo.lock

git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock hafley-rs.rev
git commit -m "release: $tag"
git tag -a "$tag" -m "$tag"

echo "git push origin main && git push origin $tag"
