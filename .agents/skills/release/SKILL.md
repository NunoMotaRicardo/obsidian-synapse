---
name: release
description: Cut a release of the plugin — version bump, build, and GitHub release with BRAT-compatible artifacts. Use when asked to release, publish, or bump the version.
---

# Release

Obsidian/BRAT expects a GitHub release whose **tag exactly equals the `manifest.json`
version (no `v` prefix)** with `main.js`, `manifest.json`, and `styles.css` attached as
individual assets.

`.github/workflows/release.yml` handles all of that automatically on tag push: it builds
`main.js`, verifies the tag matches `manifest.json`'s version, generates release notes from
`CHANGELOG.md`, and publishes the release with all three assets attached. This skill's job is
only to prepare the changelog, bump the version, and push the tag — **do not build or attach
assets by hand**, and do not run `gh release create` yourself.

## Steps

1. Decide the SemVer bump (breaking UX/config = major, feature = minor, fix = patch).
2. Move the `## [Unreleased]` section of `CHANGELOG.md` under a new `## [x.y.z] - <date>`
   heading (date in `YYYY-MM-DD`), then add a fresh empty `## [Unreleased]` above it. The
   release workflow extracts release notes from the section whose heading matches the tag, so
   this step must happen before tagging or the workflow will fail to find notes for the version.
3. `npm version <x.y.z> --no-git-tag-version` — the `version` script runs `version-bump.mjs`,
   which syncs `manifest.json` and `versions.json` (maps plugin version → `minAppVersion`).
   `version-bump.mjs` only adds a `versions.json` entry when that `minAppVersion` isn't already
   present, so check the diff — `versions.json` must reflect only versions actually released
   from this repo, not the history of the upstream fork this project started from.
4. `npm run build` and confirm it's clean; smoke-test via the deploy-test skill.
5. Commit the bump (`CHANGELOG.md`, `package.json`, `manifest.json`, `versions.json`) — ask the
   user before committing/pushing if not already authorized.
6. Tag and push: `git tag <x.y.z> && git push origin main --tags` (or `git push origin <x.y.z>`
   if `main` is already pushed). Pushing the tag triggers the release workflow — watch it with
   `gh run watch` or check `gh release view <x.y.z>` once it completes.
7. Close any issues shipped in the release (status → done, note the version).
