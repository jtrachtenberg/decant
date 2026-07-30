# decant — project instructions

## Scope

Deliver the task at the scope asked. Make routine calls yourself; check in only
when two readings of the request would produce materially different work. If
the request looks mistaken or a better approach exists, say so in one sentence
and then do what was asked — don't silently substitute your own version of the
task. Finish the whole thing, and stop at its edge.

## Delegation

Use a subagent only for large, genuinely parallel work — a wide multi-file
investigation, for example. Don't delegate anything you could finish in a few
tool calls, and don't spawn agents to check your own work. One agent beats
three; keep spawn counts low.

## End-of-task procedure (before any push / PR)

Every task ends with this sequence, in order, after the change works and its
tests pass — just before the branch is ready for push and merge:

1. **Rebuild any affected artifact** (`npm run build:cli` when CLI-reachable
   code changed) so the built binary reflects the final code.
2. **Refresh the README** (roadmap/status) when the task shipped a feature or
   changed user-visible behavior.

The user pushes and creates/merges PRs themselves; CodeQL runs on PRs as part
of the merge gate alongside tests, build, and QA.
