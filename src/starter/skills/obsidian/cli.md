# Obsidian CLI

The `obsidian` CLI talks to a running Obsidian instance — Obsidian must be open.

`obsidian help` lists every command and is always current. Full docs: https://help.obsidian.md/cli

## Syntax

**Parameters** take a value with `=`; quote values containing spaces:

```bash
obsidian create name="My Note" content="Hello world"
```

**Flags** are boolean switches with no value:

```bash
obsidian create name="My Note" silent overwrite
```

In content, use `\n` for newline and `\t` for tab.

Global flags: `--copy` copies output to clipboard · `silent` keeps files from opening · `total` returns a count on list commands.

## Targeting

**File** — without either option, the active file is used.
- `file=<name>` — resolves like a wikilink (name only, no path or extension)
- `path=<path>` — exact path from vault root, e.g. `folder/note.md`

**Vault** — defaults to the most recently focused vault. Put `vault=<name>` as the first parameter to pick one:

```bash
obsidian vault="My Vault" search query="test"
```

## Common commands

```bash
obsidian read file="My Note"
obsidian create name="New Note" content="# Hello" template="Template" silent
obsidian append file="My Note" content="New line"
obsidian search query="search term" limit=10
obsidian daily:read
obsidian daily:append content="- [ ] New task"
obsidian property:set name="status" value="done" file="My Note"
obsidian tasks daily todo
obsidian tags sort=count counts
obsidian backlinks file="My Note"
```

## Plugin and theme development

### Develop/test cycle

1. **Reload** the plugin to pick up changes:
   ```bash
   obsidian plugin:reload id=my-plugin
   ```
2. **Check errors** — if any appear, fix and return to step 1:
   ```bash
   obsidian dev:errors
   ```
3. **Verify visually** with a screenshot or DOM inspection:
   ```bash
   obsidian dev:screenshot path=screenshot.png
   obsidian dev:dom selector=".workspace-leaf" text
   ```
4. **Check console** for warnings or unexpected logs:
   ```bash
   obsidian dev:console level=error
   ```

### Other developer commands

```bash
obsidian eval code="app.vault.getFiles().length"                     # Run JS in app context
obsidian dev:css selector=".workspace-leaf" prop=background-color    # Inspect CSS values
obsidian dev:mobile on                                               # Toggle mobile emulation
```

`obsidian help` also lists CDP and debugger controls.

## Checklist

- [ ] Obsidian is running
- [ ] Every parameter value containing spaces is quoted
- [ ] `vault=` is the first parameter whenever a specific vault is targeted
- [ ] File-changing commands name `file=` or `path=` explicitly rather than relying on the active file
- [ ] After `plugin:reload`, `dev:errors` returns no errors
