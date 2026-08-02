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
5. **Mutation-test each critical behaviour you added** — a test that cannot fail
   proves nothing. For every load-bearing decision in your change (a bound, a
   guard, a comparison, a short-circuit): revert just that behaviour, PRINT the
   mutated source line to confirm the edit actually landed (no-op mutations
   have produced false green suites in this repo), run the covering tests,
   record which SPECIFIC named test failed, then restore. If a mutation
   survives — no test fails — write the missing test before proceeding. Report
   the results per behaviour in your final message, never bundled: one line per
   mutation, naming the test that killed it.
6. Open a pull request whose body includes `Fixes #{{issue_number}}` and a one-line explanation of the root cause. Push to `origin` only.

## Rules

- Do NOT refactor surrounding code or fix unrelated issues.
- Do NOT widen the change beyond what the reproduction requires.
- If the root cause turns out to be intractable or out of scope, stop and explain why in your final message rather than shipping a speculative change.
- Push to `origin` only. Never push to any other remote.
