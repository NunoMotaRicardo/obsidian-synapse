---
name: synapse-pr-comments
description: Retrieve, analyze, and implement fixes for review comments on an active GitHub pull request. Post reply comments and resolve the discussion threads using the GitHub CLI/API. Use when asked to address review comments, fix PR feedback, or resolve PR conversations (e.g. /synapse-pr-comments <#N>).
---

# /synapse-pr-comments <#N>

Addresses unresolved review-thread comments on an existing GitHub pull request on the repo
`origin` points to. Run directly in the main thread. Shares its checkout/verify/commit/push
steps with `synapse-pr-review` — see `.claude/skills/pr-workflow-shared.md` — differing only in
what drives the fixes: this skill addresses **unresolved review threads**; `synapse-pr-review`
reviews the PR's **diff**.

## Steps

1. **Checkout the PR** — see "Checkout" in `.claude/skills/pr-workflow-shared.md`.

2. **Fetch review comments** — query unresolved review threads via the GraphQL API. Derive the
   repo owner/name at runtime rather than hardcoding them:
   ```bash
   owner="$(gh repo view --json owner -q .owner.login)"
   name="$(gh repo view --json name -q .name)"
   gh api graphql -f owner="$owner" -f name="$name" -f query='
   query($owner: String!, $name: String!) {
     repository(owner: $owner, name: $name) {
       pullRequest(number: <#N>) {
         reviewThreads(first: 50) {
           nodes {
             id
             isResolved
             comments(first: 50) {
               nodes { id databaseId body path line }
             }
           }
         }
       }
     }
   }'
   ```
   Note the `id` of each unresolved thread (starts with `PRRT_`) and the `databaseId` of the
   top-level comments (needed to reply).

3. **Analyze & plan fixes** — for each unresolved thread:
   - Locate the target file (`path`) and lines (`line`) in the codebase.
   - Plan code modifications that address the reviewer's feedback.
   - Present the implementation plan to the user for feedback and approval.

4. **Implement & verify fixes** — once approved, see "Verify, commit, push" in
   `.claude/skills/pr-workflow-shared.md`.

5. **Post reply comments** — reply to each review comment thread. `gh api`'s `{owner}/{repo}`
   placeholders resolve against `origin` automatically, so no literal slug is needed:
   ```bash
   gh api -X POST "repos/{owner}/{repo}/pulls/<#N>/comments" \
     -f body="Fixed: <explanation of fix>" \
     -F in_reply_to=<comment_database_id>
   ```

6. **Resolve threads** — mark the review threads as resolved via the GraphQL mutation:
   ```bash
   gh api graphql -F threadId="<THREAD_NODE_ID>" -f query='
     mutation($threadId: ID!) {
       resolveReviewThread(input: { threadId: $threadId }) {
         thread {
           id
           isResolved
         }
       }
     }'
   ```

## Rules
- **Verify before pushing**: Never commit or push changes if linting or compilation fails.
- **Top-level comments only**: When replying using `in_reply_to`, always reference the database ID of
  the top-level comment in the thread.
- **GraphQL for resolution**: Always use `resolveReviewThread` GraphQL mutation to mark threads as
  resolved, as it is not supported in the REST API.
