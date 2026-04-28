---
name: ci-fix
description: Fix failing CI checks with minimum changes
version: "1"
allowedTools: [bash, read, edit, grep]
---

# Protocol

1. Read the failing check logs (use `gh run view` or fetch the details URL).
2. Identify the root cause — usually a lint error, type error, missing import, or test failure.
3. Fix it with the **minimum** change. One file, one line if possible.
4. Commit on the **current branch** and push to origin.
5. Reply with a one-line summary: "Fixed: <what was wrong>".

# Rules

- Do NOT refactor surrounding code.
- Do NOT add new tests unless the failure is a missing test.
- Do NOT modify files unrelated to the failure.
- Do NOT run `npm install` or `pnpm install` unless the error is a missing dependency.
- Push to `origin` only. Never push to any other remote.
- If you cannot identify the root cause after reading the logs, reply: "Could not fix: <reason>".
