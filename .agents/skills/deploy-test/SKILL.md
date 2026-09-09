---
name: deploy-test
description: Build the plugin and deploy it to the user's Obsidian vault for verification. Use after code changes to verify them in the real app, or when asked to deploy, test, or reload the plugin.
---

# Deploy & test the plugin

Target vault (never deploy a build that didn't compile clean):

The target plugin directory can be configured via `$env:SYNAPSE_DEV_VAULT` (defaults to `D:\nmr-obsidian\obsidian-configs\.obsidian\plugins\synapse\`):

```powershell
$target = if ($env:SYNAPSE_DEV_VAULT) { $env:SYNAPSE_DEV_VAULT } else { 'D:\nmr-obsidian\obsidian-configs\.obsidian\plugins\synapse\' }
```

## Steps

1. Build: `npm run build` (runs tsc typecheck, then esbuild production bundle producing
   `main.js` at the repo root). Stop and report on any error.
2. Copy artifacts:
   ```powershell
   $target = if ($env:SYNAPSE_DEV_VAULT) { $env:SYNAPSE_DEV_VAULT } else { 'D:\nmr-obsidian\obsidian-configs\.obsidian\plugins\synapse\' }
   Copy-Item main.js, manifest.json, styles.css $target -Force
   ```
3. Reload the plugin (Obsidian CLI, works while Obsidian is running):
   ```powershell
   obsidian plugin:reload id=synapse
   ```
   If the `obsidian` CLI is unavailable, tell the user to reload manually
   (**Settings → Community plugins** toggle, or Ctrl+R).
4. Verify behavior relevant to the change. For Claude connectivity: open the Synapse panel,
   check the model dropdown populates and a short chat streams. Console errors show in the
   Obsidian developer console (Ctrl+Shift+I) prefixed `[synapse]`.
5. Record the result in the active issue's "Verification log" section.
