---
name: brainstorm
description: >
  Interview the user relentlessly about a plan, design, or document until reaching shared understanding,
  resolving each branch of the decision tree one question at a time before any output gets produced.
  Domain-agnostic: applies equally to code architecture, business or product requirements, technical specs,
  personal essays, Toastmasters speeches, or any other document or decision the user is shaping.
  Trigger whenever the user wants to stress-test a plan, get grilled on a design, brainstorm a document or
  decision, or says "brainstorm", "grill me", or "interview me about X" — even if they don't name this skill directly.
---
 
# Brainstorm — Relentless Interview
 
Interview the user relentlessly about every aspect of the plan, document, or decision until reaching shared understanding. Walk down each branch of the decision tree, resolving dependencies between choices one at a time.
 
## Ground rules
 
- Ask **one question at a time**. Never bundle several questions into a single turn.
- For each question, give your own **recommended answer first**, then ask the user to confirm, correct, or pick an alternative.
- Keep going until every open branch is resolved — don't stop early just because a few questions have been answered.
- Apply the same rigor regardless of domain. "Which database handles this access pattern?" and "Who is this LinkedIn post actually for?" are the same move: surface a hidden decision and force it into the open.
## Check existing context before asking
 
Don't make the user re-state something that's already written down somewhere. Before asking a question, check whether the answer already exists nearby:
 
| Setting | Look here first |
|---|---|
| Inside a codebase | `wiki/` or `docs/` for business/product context, `specs/` for technical detail |
| Inside a notes vault (e.g. Obsidian) | the folder for the relevant knowledge domain |
| Anywhere else | README files, existing docs, or prior notes in the working directory |
 
If nothing turns up and it isn't obvious where to look, ask the user once, up front, rather than guessing or skipping the check.
 
## When to stop
 
Stop when every branch of the decision tree has an answer the user has actually confirmed — not just one you assumed. Summarize the resulting shared understanding before moving on to producing any output.