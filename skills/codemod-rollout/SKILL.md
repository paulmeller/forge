---
loopPolicy:
  maxTurns: 20
  noProgressTokens: 200000
  selfVerify: true
  acceptanceCriteria: |
    - The transformation is applied consistently across the targeted files.
    - No unrelated changes are included.
    - typecheck and the existing test suite pass.
    - A PR describing the codemod is open.
---
# codemod-rollout

Apply a codemod or automated transformation across one or more repositories.

## Goal template

```
{{codemod_description}} in {{repo}} on {{base_branch}}.
```

## Instructions

1. Understand the codemod by reading the description carefully.
2. Search the repository for all files affected by the transformation.
3. Apply the transformation to each file, ensuring correctness.
4. Run the linter and fix any style issues introduced by the transformation.
5. Run the test suite. Fix any tests broken by the transformation.
6. Open a pull request with a clear title describing the codemod.
7. In the PR body, list all files changed and a summary of the transformation applied.

## Constraints

- Do NOT make changes unrelated to the codemod.
- Preserve existing code style and formatting conventions.
- If a file is ambiguous (transformation might not apply cleanly), skip it and note it in the PR description.
