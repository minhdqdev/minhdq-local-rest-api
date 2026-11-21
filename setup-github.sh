#!/usr/bin/env bash
# Publish this fork to GitHub with gh: creates the fork under your account,
# pushes main and the tags, and cuts a release carrying the plugin files.
# Safe to re-run: every step skips what already exists.
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="minhdq-local-rest-api"
UPSTREAM="coddingtonbear/obsidian-local-rest-api"
VERSION="$(node -p 'require("./manifest.json").version' 2>/dev/null || sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json)"

gh auth status >/dev/null 2>&1 || gh auth login
gh auth setup-git
LOGIN="$(gh api user -q .login)"
FULL="$LOGIN/$REPO_NAME"
echo "→ GitHub account: $LOGIN, repo: $FULL, version: $VERSION"

# 1. A GitHub fork of upstream, renamed, so "forked from" and upstream PR/compare links work.
if ! gh repo view "$FULL" >/dev/null 2>&1; then
  gh repo fork "$UPSTREAM" --fork-name "$REPO_NAME" --clone=false --default-branch-only
  # A fresh fork can take a moment before it accepts pushes.
  for _ in 1 2 3 4 5 6 7 8 9 10; do gh repo view "$FULL" >/dev/null 2>&1 && break; sleep 3; done
fi

# 2. Remotes: origin = your fork, upstream = Adam Coddington's repo.
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$FULL.git"
git remote set-url origin "https://github.com/$FULL.git"

# 3. Push. The fork's main starts as upstream's main; this fork's history is
#    upstream 5.5.2 + our commits, so main is replaced (with lease, never blindly).
git fetch -q origin main || true
git push --force-with-lease=main origin main
git push -q origin --tags || true

gh repo edit "$FULL" \
  --default-branch main \
  --description "Fork of Local REST API with MCP for Obsidian: excluded paths hidden from every tool, Vietnamese-aware ranked search." \
  --homepage "https://minhdq.dev" >/dev/null

# 4. A release with main.js, manifest.json and styles.css (what BRAT and manual installs need).
if ! gh release view "$VERSION" -R "$FULL" >/dev/null 2>&1; then
  gh release create "$VERSION" -R "$FULL" --target main \
    --title "$VERSION" \
    --notes "Based on upstream 5.5.2.

- Adds excluded paths: matching files are invisible to every REST route and MCP tool.
- Replaces simple search with a Vietnamese-aware BM25 index (diacritic folding, tone-placement normalisation, phrase and title boosts).
- Ships under its own plugin ID, \`minhdq-local-rest-api\`, so Obsidian never offers an upstream update over it." \
    .release/main.js .release/manifest.json .release/styles.css
fi

echo "✓ https://github.com/$FULL"
