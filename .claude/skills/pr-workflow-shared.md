# Shared PR workflow steps

Used by `synapse-pr-review` and `synapse-pr-comments` — two entry points into the same
checkout → fix → verify → ship loop. They differ only in what drives the fixes: the PR's diff
for `synapse-pr-review`, unresolved review threads for `synapse-pr-comments`. This file holds the
steps identical between them so they exist once.

## Checkout

```bash
gh pr checkout <#N>
```

Verify the local working tree is clean before doing anything else.

## Verify, commit, push

Once the fixes for this round are implemented:

1. Run `npm run lint` and `npm run build` — both must be clean. **Never commit or push if either
   fails.**
2. Run the **deploy-test** skill to verify the fix in the real Obsidian vault.
3. Stage and commit:
   ```bash
   git add <modified-files>
   git commit -m "<clean, descriptive message>"
   ```
4. Push:
   ```bash
   git push origin HEAD
   ```
