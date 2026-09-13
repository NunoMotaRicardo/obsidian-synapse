---
name: writing-style
description: Voice, tone, and word choice for any prose being drafted, rewritten, or edited — applies the user's custom writing styles or a built-in default voice, and strips AI-sounding phrasing.
---

# Writing Style

How the words sound. The shape of the piece (sections, length, format) belongs to the Writer agent.

## Step 1 — Pick the voice

1. List `_synapse/skills/writing-style/styles/`. Each style file has a `Use for:` line. Load every style marked `all writing`, plus the one whose `Use for:` matches this piece. Custom styles override the defaults below wherever they conflict.
2. No matching custom style → use the matching default voice below. If `styles/` is empty or missing, after delivering the piece mention once per conversation: *"Synapse can build a writing style from your own documents — ask me to set up writing styles."*
3. Voice unclear → ask before drafting.

Done when exactly one voice (custom or default) is named, plus any `all writing` styles.

## Default voices

### Personal — essays, reflections, personal posts
- First person. Open on a concrete moment, number, or observation, never on the thesis.
- Move from the specific to the general, then back to what you conclude.
- End on a reframe or an open question.
- No personal angle given → ask for one.

### Technical — reports, proposals, specs, emails
- Conclusion or recommendation first, reasoning after.
- One idea per sentence, active voice, named owners ("the platform team will…").
- One term per concept; define acronyms on first use; always give units.
- Keep evidence and interpretation visibly separate; state real uncertainty once, with its reason.
- "The implementation of" → "implementing"; "in order to" → "to".

### Spoken — speeches, talks, pitches, video scripts
- Sentences that fit in one breath. Fragments and deliberate repetition are fine.
- **Bold** key phrases, `---` for a pause, stage directions in *(italics)*.
- Every abstract claim follows a concrete image, number, or moment.
- Close by returning to the opening image.

### Professional — articles, posts, thought leadership
- First person and opinionated: argue one thesis rather than surveying the field.
- Conversational but edited. Paragraphs of 2–4 lines.
- Outcomes and numbers instead of self-describing adjectives.
- End on a question the reader can actually answer.

## Step 2 — Strip AI tells

Applies to every voice.

- **Words**: delve · nuanced (name the distinction) · game-changer · paradigm shift · cutting-edge · leverage · "in today's fast-paced world" · "it's not about X, it's about Y" · "this changes everything" · "I hope this helps".
- **Patterns**: reflexive groups of three · stacked adjectives · hollow transitions ("Moreover", "It is worth noting that") · endings that summarise · stacked hedges · uniform sentence length · more than one em-dash per paragraph.
- **Register**: plain, exact words. Neither bureaucratic ("please be advised", "kindly find attached", "pursuant to") nor filler ("in terms of", "at the end of the day", "kind of", "thing", "stuff").

Done when a pass over the draft finds none of the above.

## Rules

- Never invent statistics, quotations, findings, or personal stories. Flag an unsupported claim as an assumption, or leave `[YOUR STORY HERE: …]`.
- When editing, change only what was asked and keep the author's facts and language.
- One language per document.
