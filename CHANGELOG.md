# Changelog

Every release, newest first. Versions follow [semantic versioning](https://semver.org).

## Unreleased

## 0.1.0

- `token-impact`: a command that lists the tokens whose resolved value changed since a commit, mode by mode, with their values before and after and the files that use them. `--json` prints it for scripts and `--files` prints only the file list.
- `readTokens`: reads DTCG, Style Dictionary, lists of named tokens and plain nested JSON, one map per mode.
- `changedTokens`: the tokens whose resolved value changed, including tokens that changed only through an alias, with the modes that changed and the alias the change came through.
- `findUses`: the files that use each token, in the spellings you choose. It follows CSS custom properties set from a token, and counts files you mark as unsure as using every token.
- `resolveTokens`, and `kebabCase`, `camelCase`, `pascalCase` and `snakeCase` for the usual spellings of a token name.
- DTCG 2025.10: root tokens (`$root`), groups that extend others (`$extends`) and JSON Pointer references (`$ref`). The command line looks for a root token with and without `$root` in its name.
- `findUses` reads each file once and indexes it by the names in it, so large repositories are much faster: 3,000 CSS files and 400 changed tokens went from 69 s to under half a second, with the same result.
- `findUses` throws on a pattern that matches no file and on a file it cannot read, instead of reporting fewer uses, and ignores the `g` and `y` flags of an `unsure` pattern, which made it miss files.
- The command no longer crashes when its output goes to a command that stops reading early, such as `head`.
