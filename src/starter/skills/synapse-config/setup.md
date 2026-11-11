# Setup

Setup has two parts, in this order: **permissions** (so Synapse stops asking about files and web pages it should be able to use), then **writing styles**. Run both when the user asks to set Synapse up; run just one when they ask for only that.

## Part 1: Permissions

The goal is a small, general permission set instead of one prompt per file. Rules live in the plugin folder's `settings.json` — format and rules: [settings.md](_synapse/skills/synapse-config/settings.md).

### Steps

1. **Read** the current `settings.json` (it may not exist) and say in one line what it allows today.
2. **Find symlinks** — list links inside the vault, up to two levels deep (Bash: `find <vault> -maxdepth 2 -type l`; PowerShell: `Get-ChildItem -Attributes ReparsePoint`), then resolve each to its real absolute path (`readlink -f`). Files reached through a link count as *outside* the vault, so each one prompts on its own — the usual cause of constant file prompts. Done when you have the list of real target roots (collapse targets nested inside another; none is fine — say so).
3. **Ask** — show each real root and ask which to grant. Say what it means: Synapse may read **and edit** files there without asking. Never grant a root the user did not confirm; warn on broad ones (a home folder, a drive root).
4. **Ask about the web** — offer bare `WebFetch` and `WebSearch` in `permissions.allow`, instead of one rule per site. Say that this lets Synapse open any web page without asking.
5. **Write** after approval: confirmed roots go in `permissions.additionalDirectories` (real paths, no trailing slash); web rules in `permissions.allow`. Keep every existing key and rule. Done when the file parses and holds exactly what the user approved.
6. **Explain** that the file is per device and that this applies from the next message. Tell them that later you can tidy rules that pile up from **Always allow** (see "Tidy permissions" in settings.md).

## Part 2: Custom writing styles

A custom style captures how the user actually writes, drawn from their own documents. It lives at `_synapse/skills/writing-style/styles/<kebab-name>.md`, where the `writing-style` skill picks it up.

## Steps

1. **Inventory** — list `styles/` and tell the user what exists. Done when the list (possibly empty) is shown.
2. **Choose styles** — suggest one style per kind of writing the user does, starting from the default voices (Personal, Technical, Spoken, Professional), plus an optional `all writing` style for conventions that hold everywhere (language variant, spelling, words they never use). Done when the user has named the styles to create.
3. **Collect samples** — for each style, ask for 3–5 documents the user wrote themselves: vault paths, wikilinks, or attachments. Offer to search the vault for candidates by folder or tag. Done when at least 2 samples per style have been read with a tool; with fewer, skip that style and say why.
4. **Analyse** — record only patterns present in at least two samples:
   - perspective and stance
   - how pieces open and end
   - sentence length and rhythm devices
   - vocabulary and register — favoured words, avoided words
   - language, variant, spelling
   - formatting habits

   Pick 2–4 short verbatim excerpts that show the voice best. Done when every template section is filled or marked "no clear pattern".
5. **Propose** — show the complete file built from the template (permission model applies).
6. **Write** — after approval. Done when the file exists and its `Use for:` line names the output types it covers.
7. **Try it** — offer to rewrite a short paragraph in the new style so the user can adjust it.

## Style file template

```markdown
# <Style Name>

Use for: <output types, or "all writing">
Based on: [[sample 1]], [[sample 2]], [[sample 3]]

## Voice
- …

## Structure
- Openings: …
- Endings: …

## Rhythm and word choice
- …

## Language
- Language / variant: …
- Prefer: … · Avoid: …

## Examples
> "<verbatim excerpt>"
```

Keep a style under ~60 lines. Describe what the user does; list bans only for real habits to avoid.
