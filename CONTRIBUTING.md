# Contributing

Thank you for helping. Bug reports, fixes and ideas are all welcome.

## Before you start

- **Bugs:** open an issue with the token file (or the smallest part of it that shows the problem), the command you ran, what it printed and what you expected.
- **New options or formats:** open an issue first, so we can agree on the API before you write it. The package does one job and stays small, so some good ideas belong in your own code instead.

## Working on it

You need Node 22.17 or later and git.

```bash
npm ci
npm test            # Vitest; the command-line tests make small git repositories in a temporary folder
npm run typecheck
npm run build       # TypeScript into dist/
node dist/bin.js --help
```

A pull request:

- does one thing, with a test that fails without it,
- adds a line under "Unreleased" in `CHANGELOG.md` saying what people get,
- keeps the package free of runtime dependencies,
- never makes the tool select fewer files when it cannot be sure,
- passes CI on Node 22 and 24.

## Releases

Maintainers move the "Unreleased" lines under a new `## X.Y.Z` heading, bump `version` in `package.json`, push the commit, then tag it `vX.Y.Z` and push the tag. The Release workflow turns that version's changelog lines into the GitHub release notes, and fails if the heading is missing. Then publish to npm.

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
