# Starter kit

Claude Synapse ships with one agent and four skills. They're general by design: useful the first time
you open the panel, and meant to be customized. They're plain Markdown in your vault's
`_synapse/` folder, so you can read and edit every line.

The kit is installed on first run in a vault without `_synapse/`, and again by **Settings →
Claude Synapse → Capabilities → Initialize**, which only adds missing files. Your edits are never
overwritten. Plugin updates don't change files you already have. To get a newer starter file,
delete or rename your copy and click **Initialize**.

| Artifact | Type | Use it when |
|---|---|---|
| [`synapse-config`](#synapse-config) | Skill | You want to change how Claude Synapse behaves, or set it up for the first time |
| [Writer](#writer-agent) | Agent | You want a finished piece of writing |
| [`writing-style`](#writing-style) | Skill | Anything is being drafted, rewritten, or edited |
| [`think`](#think) | Skill | You want to think something through before anything is produced |
| [`obsidian`](#obsidian) | Skill | Notes, Bases, or the Obsidian CLI are involved |

Every skill in `_synapse/skills/` is available in every conversation, and the assistant picks one
up when a request matches its description. You can also run one directly by typing `/name` in the
chat input, for example `/think`. An agent can limit which skills it uses with the `skills` field
in its frontmatter.

---

## synapse-config

**Customize Claude Synapse by talking to it.** This skill knows the formats of everything in
`_synapse/`: agents, skills, and MCP servers. Describe what you want:

- *"Create an agent that turns meeting notes into decisions and action items."*
- *"Add a skill with our team's release-notes format."*
- *"Connect a GitHub MCP server."*

Claude Synapse proposes the exact file (path, frontmatter, and body) and writes it only after you approve.
Deleting an artifact needs a second confirmation. New and changed files apply on your next message,
with no reload.

Its reference files load only when needed: `agents.md` and `skills.md` hold the formats and a
guide to writing skills that behave predictably. `setup.md` holds the setup workflow.

Claude Synapse also nudges you toward it. When you state a lasting preference in any conversation
("always use APA citations"), the assistant offers to turn it into an agent or skill.

### The setup workflow: writing styles from your own documents

The most valuable first customization is a writing style that sounds like you. Ask:

> Set up my writing styles.

The workflow runs in seven steps, each with a clear finish line:

1. **Inventory.** Lists existing styles in `_synapse/skills/writing-style/styles/`.
2. **Choose styles.** Suggests one style per kind of writing you do, starting from the four default
   voices, plus an optional *all writing* style for rules that hold everywhere (language variant,
   spelling, words you never use).
3. **Collect samples.** Asks for 3–5 documents you wrote yourself. Point it at vault notes or
   attachments, or let it search your vault by folder or tag. A style needs at least two samples.
4. **Analyse.** Records only patterns that appear in at least two samples: perspective, openings
   and endings, sentence rhythm, vocabulary, language, and formatting. It also picks a few
   verbatim excerpts.
5. **Propose.** Shows the complete style file.
6. **Write.** Saves it after you approve, with a `Use for:` line naming the kinds of writing it
   covers.
7. **Try it.** Offers to rewrite a short paragraph in the new style so you can adjust it.

From then on, `writing-style` loads your style automatically whenever the writing matches.

---

## Writer agent

**Finished writing, not outlines.** Select **Writer** in the agent picker, or map it to a feature
under **Settings → Claude Synapse → Feature Map & Agents**. The Writer:

1. **Names the output type**: essay or personal post, document (report, proposal, spec, email),
   speech, or article.
2. **Confirms the brief** once, asking only for what's missing: audience, purpose, language,
   length, and sources.
3. **Drafts** a complete piece using a proven structure. For example, a proposal goes problem →
   solution → alternatives → scope → cost → success criteria. A speech goes hook → bridge → 2–3
   points → callback close. Claims are grounded in your vault or marked as assumptions.
4. **Refines** only the parts you ask to change, and always delivers the whole piece.

The Writer owns **structure**. It always loads `writing-style` for **voice**.

## writing-style

**How the words sound.** On every writing task it:

- **Picks a voice.** It uses your custom styles when one matches. Otherwise it uses a built-in
  voice: **Personal** (essays, reflections), **Technical** (reports, emails: conclusion first,
  one idea per sentence), **Spoken** (speeches: breath-length sentences, callbacks), or
  **Professional** (articles: one clear thesis, numbers over adjectives).
- **Strips AI tells.** It removes words like *delve* and *leverage*, reflexive groups of three,
  hollow transitions, summarizing endings, and stacked hedges.
- **Keeps it honest.** It never invents statistics, quotes, or personal stories. Unsupported claims
  are flagged, and missing stories become `[YOUR STORY HERE: …]` placeholders.

It works in any conversation, not just with the Writer. Ask Claude Synapse to rewrite an email or tighten
a paragraph and the same voice rules apply.

## think

**Think before writing.** Say *"think this through with me"* or *"interview me about this plan"*
and Claude Synapse asks **one question at a time**, each with a recommended answer you can accept or
change. It checks the active note, linked notes, and the topic's folder before asking, so it
doesn't ask what's already written down. It stops only when every open point has an answer you've
confirmed, then summarizes what was agreed before producing anything.

It suits project plans, decisions, research questions, and the brief for a piece the Writer will
draft.

## obsidian

**Notes that render correctly.** It gives the assistant precise knowledge of:

- **Obsidian Flavored Markdown**: wikilinks, embeds, callouts, properties, tags, math, and diagrams.
- **Bases**: `.base` files with filters, formulas, and views, plus a function reference.
- **The `obsidian` CLI**: reading, creating, and searching notes, and debugging plugins and
  themes in a running Obsidian.

It loads only the reference files a task needs, runs a checklist before finishing, and verifies the
result through the CLI when Obsidian is running.

---

## Suggested reading

- [Customization](Customization.md): agent, skill, and MCP file formats in full
- [Using Claude Synapse](Using-Synapse.md): where to pick agents and toggle skills
