# dependency-bump

Bump a dependency to a target version across one or more repositories.

## Goal template

```
Bump {{package}} to {{target_version}} in {{repo}} on {{base_branch}}.
```

## Instructions

1. Read the lockfile (package-lock.json, pnpm-lock.yaml, or yarn.lock) to confirm the current version.
2. Update the dependency in package.json (or the relevant manifest) to the target version.
3. Run the package manager's install command to regenerate the lockfile.
4. If there are TypeScript compilation errors caused by the version bump, fix them.
5. Run the existing test suite. If tests fail due to the version change, fix them.
6. Open a pull request with a clear title: `chore(deps): bump <package> to <version>`.

## Constraints

- Do NOT bump any other dependencies besides the one specified.
- Do NOT refactor code unrelated to the version bump.
- If the bump introduces a breaking change, consult the package's CHANGELOG or migration guide.
