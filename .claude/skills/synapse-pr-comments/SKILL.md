---
name: synapse-pr-comments
description: Retrieve, analyze, and implement fixes for review comments on an active GitHub pull request. Post reply comments and resolve the discussion threads using the GitHub CLI/API. Use when asked to address review comments, fix PR feedback, or resolve PR conversations (e.g. /synapse-pr-comments <#N>).
---

# /synapse-pr-comments <#N>

Checks out an existing GitHub pull request, fetches its review comments and discussion threads, analyzes and plans code fixes, implements the changes, commits/pushes them, posts replies, and resolves the threads. This is a unified workflow run directly in the main thread.

## Steps

1. **Checkout the PR** — Fetch and switch to the PR branch using the GitHub CLI:
   ```bash
   gh pr checkout <#N>
   ```
   Verify that the local working tree is clean.

2. **Fetch Review Comments** — Query unresolved review threads and comment details using the GraphQL API:
   ```bash
   gh api graphql -f query='
   query {
     repository(owner: "NunoMotaRicardo", name: "obsidian-claude-brain") {
       pullRequest(number: <#N>) {
         reviewThreads(first: 50) {
           nodes {
             id
             isResolved
             comments(first: 50) {
               nodes {
                 id
                 databaseId
                 body
                 path
                 line
               }
             }
           }
         }
       }
     }
   }'
   ```
   Note the `id` of each unresolved thread (starts with `PRRT_`) and the `databaseId` of the top-level comments (which is needed to reply).

3. **Analyze & Plan Fixes** — For each unresolved thread:
   - Locate the target file (`path`) and lines (`line`) in the codebase.
   - Plan code modifications that address the reviewer's feedback.
   - Present the implementation plan to the user for feedback and approval.

4. **Implement & Verify Fixes** — Once approved:
   - Edit the target files to apply the fixes.
   - Run compilation and lint checks:
     - `npm run lint`
     - `npm run build`
   - Deploy-test locally in the Obsidian vault (refer to `deploy-test` skill) to verify correctness.

5. **Stage, Commit, & Push**:
   - Stage and commit the fixes:
     ```bash
     git add <modified-files>
     git commit -m "fix(pr-<#N>): address reviewer feedback..."
     ```
   - Push to the remote branch:
     ```bash
     git push origin HEAD
     ```

6. **Post Reply Comments** — Reply to each review comment thread using the REST API:
   - Construct the JSON payload for the reply (or use `gh api -f body="..." -F in_reply_to=<databaseId>`):
     ```bash
     gh api -X POST /repos/NunoMotaRicardo/obsidian-claude-brain/pulls/<#N>/comments \
       -f body="Fixed: <explanation of fix>" \
       -F in_reply_to=<comment_database_id>
     ```

7. **Resolve Threads** — Mark the review threads as resolved via the GraphQL mutation:
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
- **Top-level comments only**: When replying using `in_reply_to`, always reference the database ID of the top-level comment in the thread.
- **GraphQL for resolution**: Always use `resolveReviewThread` GraphQL mutation to mark threads as resolved, as it is not supported in the REST API.
