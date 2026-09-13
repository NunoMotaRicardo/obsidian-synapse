# Setup: custom writing styles

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
