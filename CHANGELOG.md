# Changelog

Every release, newest first. Versions follow [semantic versioning](https://semver.org).

## Unreleased

- `token-impact`: a command that lists the tokens whose resolved value changed since a commit, mode by mode, with their values before and after and the files that use them. `--json` prints it for scripts and `--files` prints only the file list.
- `readTokens`: reads DTCG, Style Dictionary, lists of named tokens and plain nested JSON, one map per mode.
- `changedTokens`: the tokens whose resolved value changed, including tokens that changed only through an alias, with the modes that changed and the alias the change came through.
- `findUses`: the files that use each token, in the spellings you choose. It follows CSS custom properties set from a token, and counts files you mark as unsure as using every token.
- `resolveTokens`, and `kebabCase`, `camelCase`, `pascalCase` and `snakeCase` for the usual spellings of a token name.
