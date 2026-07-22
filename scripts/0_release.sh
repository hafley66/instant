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

perl -0pi -e "s/(\"version\": \")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/" package.json
perl -0pi -e "s/^(version = \")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/m" src-tauri/Cargo.toml
perl -0pi -e "s/(\"version\": \")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/" src-tauri/tauri.conf.json

git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "release: $tag"
git tag -a "$tag" -m "$tag"

echo "git push origin main && git push origin $tag"
