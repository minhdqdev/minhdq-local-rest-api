#!/usr/bin/env bash
# Push main + tags and publish a GitHub release for the version in manifest.json,
# attaching the prebuilt plugin files in .release/. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json | head -1)"
FULL="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
for f in main.js manifest.json styles.css; do test -f ".release/$f" || { echo "missing .release/$f"; exit 1; }; done
grep -q "\"version\": \"$VERSION\"" .release/manifest.json || { echo ".release/manifest.json is not $VERSION"; exit 1; }
gh auth setup-git
git push origin main
git tag -f "$VERSION" HEAD >/dev/null
git push -f origin "refs/tags/$VERSION"
if gh release view "$VERSION" -R "$FULL" >/dev/null 2>&1; then
  gh release upload "$VERSION" -R "$FULL" --clobber .release/main.js .release/manifest.json .release/styles.css
else
  gh release create "$VERSION" -R "$FULL" --verify-tag --title "$VERSION" \
    --notes-file <(git log -1 --format=%B) \
    .release/main.js .release/manifest.json .release/styles.css
fi
echo "✓ https://github.com/$FULL/releases/tag/$VERSION"
