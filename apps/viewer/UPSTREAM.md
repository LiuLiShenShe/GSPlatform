# SuperSplat Viewer Fork — Upstream Tracking

## Source

- **Upstream repository:** https://github.com/playcanvas/supersplat
- **Fork repository:** https://github.com/LiuLiShenShe/supersplat
- **Fork created:** 2026-09-09
- **Baseline commit:** `12398f7f6997bd59bdd82876fd90fc87a6ec6f68` (tag: 3.0.0, 2026-09-08)
- **License:** MIT (see LICENSE in this directory)

## How to update from upstream

```bash
# Add upstream remote (if not already added)
cd apps/viewer
git remote add upstream https://github.com/playcanvas/supersplat.git

# Fetch upstream
git fetch upstream main

# Create a sync commit (single commit only, no mixed changes)
git checkout main
git merge upstream/main --no-edit

# Push the fork
git push origin main

# Copy vendored source into monorepo
cd /fj/GSPlatform
# ... copy updated source into apps/viewer ...
```

## Sync method

Currently vendored: source is copied into the monorepo and `.git` metadata is removed.
Upstream sync is performed as a dedicated commit on the GitHub fork, then vendored source is refreshed.

## Notes

- The viewer uses Rollup for builds and a static `serve` for dev mode.
- Dev server port is configured to **5174** in the workspace package.json scripts.
