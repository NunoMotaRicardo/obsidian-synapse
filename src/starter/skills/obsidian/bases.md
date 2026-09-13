# Obsidian Bases

A Base is a `.base` file containing YAML that defines database-like views over notes.

## Build order

1. **Scope** — `filters` selecting which notes appear (tag, folder, property, date).
2. **Formulas** (optional) — computed properties in `formulas`.
3. **Properties** (optional) — display names in `properties`.
4. **Views** — one or more of `table`, `cards`, `list`, `map`, each with `order` listing the columns shown.

## Schema

```yaml
# Global filters apply to ALL views in the base
filters:
  # A single filter string, OR a recursive object with and/or/not
  and: []
  or: []
  not: []

# Formula properties usable across all views
formulas:
  formula_name: 'expression'

# Display names and settings for properties
properties:
  property_name:
    displayName: "Display Name"
  formula.formula_name:
    displayName: "Formula Display Name"
  file.ext:
    displayName: "Extension"

# Custom summary formulas
summaries:
  custom_summary_name: 'values.mean().round(3)'

# One or more views
views:
  - type: table | cards | list | map
    name: "View Name"
    limit: 10                    # Optional: limit results
    groupBy:                     # Optional: group results
      property: property_name
      direction: ASC | DESC
    filters:                     # View-specific filters (combined with global)
      and: []
    order:                       # Properties to display, in order
      - file.name
      - property_name
      - formula.formula_name
    summaries:                   # Map properties to summary formulas
      property_name: Average
```

## Filters

```yaml
# Single filter
filters: 'status == "done"'

# AND - all conditions must be true
filters:
  and:
    - 'status == "done"'
    - 'priority > 3'

# OR - any condition can be true
filters:
  or:
    - 'file.hasTag("book")'
    - 'file.hasTag("article")'

# NOT - exclude matching items
filters:
  not:
    - 'file.hasTag("archived")'

# Nested
filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
```

| Operator | Description |
|----------|-------------|
| `==` / `!=` | equals / not equal |
| `>` / `<` / `>=` / `<=` | comparisons |
| `&&` | logical and |
| `\|\|` | logical or |
| <code>!</code> | logical not |

## Properties

Three kinds:
1. **Note properties** — frontmatter: `author` or `note.author`
2. **File properties** — file metadata: `file.name`, `file.mtime`, …
3. **Formula properties** — computed: `formula.my_formula`

| File property | Type | Description |
|----------|------|-------------|
| `file.name` | String | File name |
| `file.basename` | String | File name without extension |
| `file.path` | String | Full path to file |
| `file.folder` | String | Parent folder path |
| `file.ext` | String | File extension |
| `file.size` | Number | File size in bytes |
| `file.ctime` | Date | Created time |
| `file.mtime` | Date | Modified time |
| `file.tags` | List | All tags in file |
| `file.links` | List | Internal links in file |
| `file.backlinks` | List | Files linking to this file |
| `file.embeds` | List | Embeds in the note |
| `file.properties` | Object | All frontmatter properties |

**`this`** refers to: the base file itself (main content area) · the embedding file (when embedded) · the active file (in sidebar).

## Formulas

```yaml
formulas:
  total: "price * quantity"                                   # Arithmetic
  status_icon: 'if(done, "✅", "⏳")'                          # Conditional
  formatted_price: 'if(price, price.toFixed(2) + " dollars")' # String formatting
  created: 'file.ctime.format("YYYY-MM-DD")'                  # Date formatting
  days_old: '(now() - file.ctime).days'                       # Days since created
  days_until_due: 'if(due_date, (date(due_date) - today()).days, "")'
```

### Core functions

For String, Number, List, File, Link, Object, and RegExp methods, load [bases-functions.md](_synapse/skills/obsidian/bases-functions.md).

| Function | Signature | Description |
|----------|-----------|-------------|
| `date()` | `date(string): date` | Parse string to date (`YYYY-MM-DD HH:mm:ss`) |
| `now()` | `now(): date` | Current date and time |
| `today()` | `today(): date` | Current date (time = 00:00:00) |
| `if()` | `if(condition, trueResult, falseResult?)` | Conditional |
| `duration()` | `duration(string): duration` | Parse duration string |
| `file()` | `file(path): file` | Get file object |
| `link()` | `link(path, display?): Link` | Create a link |

### Dates and Durations

Subtracting two dates returns a **Duration**, not a number.

**Duration fields** (all Number): `.days`, `.hours`, `.minutes`, `.seconds`, `.milliseconds`

Duration has no `.round()`, `.floor()`, `.ceil()`, and cannot be divided into a number. Read a numeric field first, then apply number functions.

```yaml
# CORRECT
"(date(due_date) - today()).days"              # Days between dates
"(date(due_date) - today()).days.round(0)"     # Rounded days
"(now() - file.ctime).hours.round(0)"          # Rounded hours

# WRONG
"(now() - file.ctime).round(0)"                # Duration is not a number
"((date(due) - today()) / 86400000).round(0)"  # No division on Duration
```

Date arithmetic with duration strings:

```yaml
# Units: y/year/years, M/month/months, d/day/days, w/week/weeks,
#        h/hour/hours, m/minute/minutes, s/second/seconds
"date + \"1M\""                  # Add 1 month
"date - \"2h\""                  # Subtract 2 hours
"now() + \"1 day\""              # Tomorrow
"today() + \"7d\""               # A week from today
"now() + (duration('1d') * 2)"   # Duration arithmetic
```

## Views

```yaml
views:
  - type: table
    name: "My Table"
    order: [file.name, status, due_date]
    summaries:
      price: Sum
      count: Average

  - type: cards
    name: "Gallery"
    order: [file.name, cover_image, description]

  - type: list
    name: "Simple List"
    order: [file.name, status]

  - type: map          # Needs lat/lng properties and the Maps community plugin
    name: "Locations"
```

### Default summaries

| Name | Input | Description |
|------|-------|-------------|
| `Average` | Number | Mean |
| `Min` / `Max` | Number | Smallest / largest |
| `Sum` | Number | Sum |
| `Range` | Number | Max − Min |
| `Median` | Number | Median |
| `Stddev` | Number | Standard deviation |
| `Earliest` / `Latest` | Date | Earliest / latest date |
| `Range` | Date | Latest − Earliest |
| `Checked` / `Unchecked` | Boolean | Count of true / false |
| `Empty` / `Filled` | Any | Count of empty / non-empty |
| `Unique` | Any | Count of unique values |

## Embedding

```markdown
![[MyBase.base]]
![[MyBase.base#View Name]]
```

## Examples

### Task Tracker

```yaml
filters:
  and:
    - file.hasTag("task")
    - 'file.ext == "md"'

formulas:
  days_until_due: 'if(due, (date(due) - today()).days, "")'
  is_overdue: 'if(due, date(due) < today() && status != "done", false)'
  priority_label: 'if(priority == 1, "🔴 High", if(priority == 2, "🟡 Medium", "🟢 Low"))'

properties:
  status:
    displayName: Status
  formula.days_until_due:
    displayName: "Days Until Due"
  formula.priority_label:
    displayName: Priority

views:
  - type: table
    name: "Active Tasks"
    filters:
      and:
        - 'status != "done"'
    order:
      - file.name
      - status
      - formula.priority_label
      - due
      - formula.days_until_due
    groupBy:
      property: status
      direction: ASC
    summaries:
      formula.days_until_due: Average

  - type: table
    name: "Completed"
    filters:
      and:
        - 'status == "done"'
    order:
      - file.name
      - completed_date
```

### Reading List

```yaml
filters:
  or:
    - file.hasTag("book")
    - file.hasTag("article")

formulas:
  reading_time: 'if(pages, (pages * 2).toString() + " min", "")'
  status_icon: 'if(status == "reading", "📖", if(status == "done", "✅", "📚"))'
  year_read: 'if(finished_date, date(finished_date).year, "")'

properties:
  author:
    displayName: Author
  formula.status_icon:
    displayName: ""
  formula.reading_time:
    displayName: "Est. Time"

views:
  - type: cards
    name: "Library"
    order:
      - cover
      - file.name
      - author
      - formula.status_icon
    filters:
      not:
        - 'status == "dropped"'

  - type: table
    name: "Reading List"
    filters:
      and:
        - 'status == "to-read"'
    order:
      - file.name
      - author
      - pages
      - formula.reading_time
```

### Daily Notes Index

```yaml
filters:
  and:
    - file.inFolder("Daily Notes")
    - '/^\d{4}-\d{2}-\d{2}$/.matches(file.basename)'

formulas:
  word_estimate: '(file.size / 5).round(0)'
  day_of_week: 'date(file.basename).format("dddd")'

properties:
  formula.day_of_week:
    displayName: "Day"
  formula.word_estimate:
    displayName: "~Words"

views:
  - type: table
    name: "Recent Notes"
    limit: 30
    order:
      - file.name
      - formula.day_of_week
      - formula.word_estimate
      - file.mtime
```

## Troubleshooting

**Unquoted special characters** — see the YAML rule in SKILL.md.

```yaml
displayName: Status: Active      # WRONG
displayName: "Status: Active"    # CORRECT
```

**Mismatched quotes** — a formula containing double quotes goes in single quotes.

```yaml
label: "if(done, "Yes", "No")"   # WRONG
label: 'if(done, "Yes", "No")'   # CORRECT
```

**Missing null guard** — properties may be absent on some notes.

```yaml
"(date(due_date) - today()).days"                    # WRONG: fails when empty
'if(due_date, (date(due_date) - today()).days, "")'  # CORRECT
```

**Undefined formula** — `formula.total` in `order` fails silently unless `total` exists under `formulas`.

## Checklist

- [ ] File has the `.base` extension and parses as valid YAML
- [ ] Every `formula.X` used in `order`, `properties`, `summaries`, or `groupBy` is defined in `formulas`
- [ ] Every date subtraction reads a Duration field (`.days`, `.hours`, …) before any number function
- [ ] Every property that may be missing on some notes is guarded with `if()`
- [ ] Every view `type` is `table`, `cards`, `list`, or `map`; `map` views have lat/lng properties
- [ ] Every summary name is a default summary or defined under `summaries`

## Docs

[Syntax](https://help.obsidian.md/bases/syntax) · [Functions](https://help.obsidian.md/bases/functions) · [Views](https://help.obsidian.md/bases/views) · [Formulas](https://help.obsidian.md/formulas)
