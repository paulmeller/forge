---
version: "1"
allowedTools: [bash, read, grep, edit]
loopPolicy:
  maxTurns: 12
  noProgressTokens: 100000
  selfVerify: false
  acceptanceCriteria: |
    - A minimal reproduction was attempted for the reported bug.
    - A `forge-verdict` block was emitted as the final message.
---

# bug-reproduce

Confirm whether a reported bug actually reproduces, and record a machine-readable verdict. This is the first stage of a triage Mission — it opens no pull request. A dependent fix stage runs only if the bug reproduces.

## Context

- Repository: `{{repo}}`
- Issue: #{{issue_number}} — {{issue_title}}
- Report:

{{issue_body}}

## Protocol

1. Read the issue and identify the smallest observable symptom (a failing assertion, a wrong return value, a thrown error).
2. Write the **minimum** reproduction — a focused failing test in the repo's existing test layout. It becomes the fix stage's regression guard, so make it a real test, not a throwaway script.
3. Run it. Observe the actual vs. expected behaviour (you want to see it fail).
4. If the issue names specific versions (e.g. "broken in v5, works in v6"), check each version you reasonably can — `git checkout` the tag, or install the pinned version in a scratch dir — and record which are affected.
5. If (and only if) the bug reproduced, commit the failing test on a branch named exactly `forge/triage-{{issue_number}}` and push it to `origin`. Report that branch in the verdict's `branch` field so the fix stage can build on it. Do **not** attempt a fix, and do **not** open a pull request.

## Emitting the verdict

End your final turn with exactly one fenced `forge-verdict` block. Forge parses this to decide whether the fix stage runs — a malformed or missing block abandons the triage.

```forge-verdict
{
  "reproduced": true,
  "summary": "one sentence: what the bug is and how it manifests",
  "affectedVersions": { "v5.0": true, "v6.0": false },
  "evidence": "the failing test name or a one-line stack/assertion excerpt",
  "branch": "forge/triage-{{issue_number}}"
}
```

## Rules

- `reproduced` is `true` only if you observed the symptom yourself. If you could not reproduce it, emit `"reproduced": false` with a summary of what you tried — do not guess. Omit `branch` in that case (there is nothing to hand off).
- `affectedVersions` is optional; include it only when you actually tested versions.
- Keep the repro test minimal and unrelated-change-free. Push to `origin` only; never open a PR.
