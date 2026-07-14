# decant — project instructions

## End-of-task procedure (before any push / PR)

Every task ends with this sequence, in order, after the change works and its
tests pass — just before the branch is ready for push and merge:

1. **Self-audit the code you touched.** Re-read the final state of every file
   you changed and look for: dead code (unused exports, imports, variables,
   branches that can't run), duplicate logic (including pre-existing
   duplication your change now touches — hoist it), unused components, and
   unnecessary complexity (guards for cases that can't happen, ternaries that
   collapse, abstraction the call sites don't need). Fix what you find, and
   verify assumptions empirically (run the code) rather than assuming an API
   needs a guard.
2. **Re-run the full test suite** (`npm test`) and rebuild any affected
   artifact (`npm run build:cli` when CLI-reachable code changed) so the
   built binary reflects the final code.
3. **Refresh the README** (roadmap/status) when the task shipped a feature or
   changed user-visible behavior.

The user pushes and creates/merges PRs themselves; CodeQL runs on PRs as part
of the merge gate alongside tests, build, and QA.
