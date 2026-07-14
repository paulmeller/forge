---
version: "1"
allowedTools: [bash, read, grep, edit]
loopPolicy:
  maxTurns: 18
  noProgressTokens: 140000
  selfVerify: true
  acceptanceCriteria: |
    - The reproduction from the reproduce stage now passes.
    - The change is minimal and scoped to the reported bug — no unrelated refactors.
    - No new test, type, or lint failures were introduced.
    - A pull request is open, its body links the issue with `Fixes #<number>`.
---

# bug-fix

Fix a bug that has already been confirmed to reproduce, and open a pull request. This is the second stage of a triage Mission — it runs only because the reproduce stage returned a positive verdict, so you can trust the bug is real and start from its evidence.

## Context

- Repository: `{{repo}}`
- Issue: #{{issue_number}} — {{issue_title}}
- Confirmed reproduction: {{repro_summary}}
- Affected versions: {{affected_versions}}
- Evidence: {{repro_evidence}}
- Regression test branch: `{{repro_branch}}` (the reproduce stage pushed a failing test here)

Original report:

{{issue_body}}

## Protocol

1. Bring in the failing regression test the reproduce stage pushed: if `{{repro_branch}}` is set, `git fetch origin {{repro_branch}}` and cherry-pick or check out its test onto your working branch. Run it and confirm it fails (red) before you change anything. If no branch was provided, reproduce the failure yourself from the evidence above.
2. Find the root cause. Fix it with the **minimum** change that makes the reproduction pass.
3. Keep (or add) a regression test that fails without your fix and passes with it.
4. Run the repo's test and lint commands. Ensure nothing new breaks.
5. Open a pull request whose body includes `Fixes #{{issue_number}}` and a one-line explanation of the root cause. Push to `origin` only.

## Rules

- Do NOT refactor surrounding code or fix unrelated issues.
- Do NOT widen the change beyond what the reproduction requires.
- If the root cause turns out to be intractable or out of scope, stop and explain why in your final message rather than shipping a speculative change.
- Push to `origin` only. Never push to any other remote.
