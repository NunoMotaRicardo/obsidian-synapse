---
name: release
description: Cut a release of the plugin — version bump, build, and GitHub release with BRAT-compatible artifacts. Use when asked to release, publish, or bump the version.
---

# Release

Obsidian/BRAT expects a GitHub release whose **tag exactly equals the `manifest.json`
version (no `v` prefix)** with `main.js`, `manifest.json`, and `styles.css` attached as
individual assets.

## Steps

1. Decide the SemVer bump (breaking UX/config = major, feature = minor, fix = patch).
2. `npm version <x.y.z> --no-git-tag-version` — the `version` script runs `version-bump.mjs`,
   which syncs `manifest.json` and `versions.json` (maps plugin version → `minAppVersion`).
3. `npm run build` and confirm it's clean; smoke-test via the deploy-test skill.
4. Commit the bump (`package.json`, `manifest.json`, `versions.json`) — ask the user before
   committing/pushing if not already authorized.
5. Create the release:
   ```powershell
   gh release create <x.y.z> main.js manifest.json styles.css --title "<x.y.z>" --notes "<highlights>"
   ```
6. Close any issues shipped in the release (status → done, note the version).
