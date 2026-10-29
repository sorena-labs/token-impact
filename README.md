# token-impact

Lists the design tokens a change touches, and the files that use them.

Change one token and every screen that uses it can look different. A test selector that works file by file only knows that the token file changed, so it captures every screenshot again. token-impact reads the token file before and after the change, resolves every alias in every mode, and lists the tokens whose final value changed, including tokens that changed only because an alias they point at did. Then it finds the CSS, Dart, Swift, Kotlin or TypeScript files that use them, so you rerun only the tests and screenshots those files feed, and a reviewer sees what changed.

When it cannot be sure, it selects more, never less. An extra screenshot costs seconds; a missed one ships a change nobody saw.

## Install

```bash
npm install --save-dev token-impact
```

Node 22.17 or later. No runtime dependencies.

## Command line

```bash
npx token-impact --tokens tokens.json --base origin/main --modes dark,light \
  --css "src/**/*.css" \
  --camel "lib/**/*.dart"
```

```
3 tokens changed, used in 3 files.

color.brand  changed
  dark  #2f6fde -> #3b7cf0
  Used in 2 files:
    lib/button.dart
    src/button.css

color.link  changed via color.brand
  dark  #2f6fde -> #3b7cf0
  Used in 1 file:
    src/link.css

radius.md  changed
  12px -> 14px
  Not used in the searched files.
```

It compares the working tree with the commit where your branch left `--base`, the way a pull request diff does, so changes made on `origin/main` since you branched are not counted. Without `--base` it compares with `HEAD`.

| Option | What it does |
|---|---|
| `--tokens <file>` | A JSON token file: DTCG, Style Dictionary or plain JSON. Repeat for several; later files win. |
| `--base <commit>` | Compare with the commit where this branch left `<commit>`. Default `HEAD`. |
| `--modes <list>` | Mode names, comma separated, such as `dark,light`. |
| `--css <glob>` | Files that use tokens as CSS custom properties: `--color-brand`. Properties set from a token count too: with `--fill: var(--color-brand)`, every use of `--fill` is a use of `color.brand`. |
| `--scss <glob>` | Files that use tokens as Sass variables: `$color-brand`. |
| `--camel <glob>` | Files that use camelCase names: `colorBrand` (Dart, Swift, Kotlin, JS). |
| `--pascal <glob>` | Files that use PascalCase names: `ColorBrand`. |
| `--snake <glob>` | Files that use snake_case names: `color_brand` (Android resources). |
| `--string <glob>` | Files that use the token name in quotes: `"color.brand"`. |
| `--json` | Print `{ changes, uses }` as JSON: `changes` is what [`changedTokens`](#changedtokensbase-head) returns, `uses` what [`findUses`](#findusestokens-rules--cwd-) returns. |
| `--files` | Print only the files that use a changed token, one per line. |
| `--help` | Show every option. |

Repeat a file option for several globs, and quote each glob so the shell leaves it alone. `node_modules` and `.git` are skipped. Marking files as unsure needs the API.

A DTCG root token is looked for with and without `$root`: `color.accent.$root` as both `--color-accent-root` and `--color-accent`.

On a wrong option, a commit it cannot find, a file that is not valid JSON, a circular reference, a glob that matches no file or a file it cannot read, it says what went wrong and exits with 1.

`--files` is for scripts: hand the list to whatever picks your tests and screenshots.

```bash
npx token-impact --tokens tokens.json --base origin/main --css "src/**/*.css" --files > affected.txt
```

## API

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { camelCase, changedTokens, findUses, kebabCase, readTokens } from "token-impact";

const modes = { modes: ["dark", "light"] };
const baseText = execFileSync("git", ["show", "origin/main:tokens.json"], { encoding: "utf8" });
const base = readTokens(JSON.parse(baseText), modes);
const head = readTokens(JSON.parse(readFileSync("tokens.json", "utf8")), modes);

const changes = changedTokens(base, head);
// [{ name: "color.brand", change: "changed", modes: ["dark"], via: [],
//    before: { dark: "#2f6fde", light: "#1f5bc4" }, after: { dark: "#3b7cf0", light: "#1f5bc4" } }, ...]

const uses = await findUses(
  changes.map((change) => change.name),
  [
    { files: ["src/**/*.css"], name: (token) => `--${kebabCase(token)}`, follow: true },
    { files: ["lib/**/*.dart"], name: (token) => `.${camelCase(token)}` },
  ],
);
// { byToken: { "color.brand": ["lib/button.dart", "src/button.css"], ... }, unsure: [], files: [...] }
```

### `readTokens(doc, { modes? })`

Flattens a parsed token document into one map of raw values per mode: `{ dark: { "color.brand": "#2f6fde", ... }, light: { ... } }`. Without `modes` the only mode is `default`.

- DTCG: an object with `$value` is a token, named by its path (`color.brand`).
- Style Dictionary: an object with `value` is a token, named by its path.
- Lists: an item with `name` and `value` (or `$value`) is a token named by its `name` alone. Any other item is read like a group, named by its position: `spacing.tokens.1`.
- Plain nested JSON: any other string, number or boolean is a token, named by its path.
- DTCG root tokens keep `$root` in their name: `color.accent.$root`.
- A DTCG group with `$extends` (`"{field}"` or `{ "$ref": "#/field" }`) gets the tokens of the group it names, and its own tokens replace inherited ones whole. A loop, or extending something that is not a group, throws.
- Other keys that start with `$` (`$type`, `$description`) are skipped.

It takes the parsed document, so token files written in JavaScript, JSON5 or YAML work too: load them yourself and pass the object. The command line reads JSON only.

With `modes`, a value that is an object with only those keys holds one value per mode: `{ "dark": "#2f6fde", "light": "#1f5bc4" }`. Any other value is the same in every mode. If your modes live in separate files, put each mode's file over the shared one, the same way for both sides:

```ts
// The parsed files: core, dark and light, at the base commit and now.
const byMode = (core: unknown, dark: unknown, light: unknown) => ({
  dark: { ...readTokens(core).default, ...readTokens(dark).default },
  light: { ...readTokens(core).default, ...readTokens(light).default },
});
changedTokens(byMode(baseCore, baseDark, baseLight), byMode(headCore, headDark, headLight));
```

### `changedTokens(base, head)`

The tokens whose resolved value changed in any mode, in document order with removed tokens last. Each change has:

- `name`
- `change`: `"added"`, `"removed"` or `"changed"`
- `modes`: the modes whose resolved value changed
- `via`: when the token's own value is the same, the tokens it points at directly that changed. If `color.link` points at `color.text` and `color.text` at `color.brand`, a change to `color.brand` shows `color.text` via `color.brand` and `color.link` via `color.text`.
- `before`, `after`: the resolved value in each mode the token has, so an added token's `before` is `{}`

Values are compared by content, so reordering the keys of a composite value is not a change. A circular reference on either side throws and names the loop, even one the branch has fixed, since the base side is resolved too.

### `findUses(tokens, rules, { cwd? })`

Finds the files that use each token. A rule has:

- `files`: glob patterns, relative to `cwd`
- `name(token)`: how a token is written in those files, one spelling or several
- `follow`: CSS only. With `--fill: var(--color-brand)` anywhere in the rule's files, every use of `--fill` counts as a use of `color.brand` too, through any number of steps. It ignores selectors and media queries, so it selects more.
- `unsure`: a pattern for files that read tokens in a way that cannot be followed, such as `/var\(--#\{/` for Sass interpolation. When any token is passed, those files count as using every token. Its `g` and `y` flags are ignored.

It returns `byToken` (the files for each token), `unsure` (the files that matched an `unsure` pattern, which are not repeated in `byToken`) and `files` (every file once), all sorted, with `/` separators.

A pattern that matches no file throws, and so does a file it cannot read, since either would hide uses. Folders a pattern matches are skipped. Each file is read once, however many rules match it, and indexed by the names in it, so the time grows with the size of the files, not with the number of tokens times the number of files.

Names match as whole words: `--color-brand` is not found inside `--color-brand-text`, nor `colorBrand` inside `colorBrandText`. A spelling that starts or ends with a character that is not part of a name, such as the dot in `.colorBrand`, matches next to anything. It searches the text and does not parse it, so a name in a comment or a string counts too, which selects more.

### `resolveTokens(tokens)`

Replaces every `{alias}` in one mode's map with the value it points at, through any number of steps, including aliases inside strings (`"0 0 0 2px {color.focus}"`) and inside composite values. DTCG JSON Pointers work too: `{ "$ref": "#/color/brand/$value" }` is the value of `color.brand`, and `#/color/brand/$value/components/0` one part of it. A reference to a missing token is left as written; a circular one throws and names the loop.

### `kebabCase`, `camelCase`, `pascalCase`, `snakeCase`

The usual spellings of a token name, split at any separator and where lower case turns to upper: `color.brand-text` becomes `color-brand-text`, `colorBrandText`, `ColorBrandText` and `color_brand_text`.

Digits stay with the word before them: `space-2xs` becomes `space2xs`, where lodash's `camelCase` writes `space2Xs`. Check them against your generated code: a spelling that does not match finds nothing.

## What it can miss

- A token whose name is built at run time, such as `` `var(--${name})` ``. Mark those files with `unsure`.
- A spelling you did not give. If your generated code spells `color.brand` as `AppColors.primary`, pass a `name` that says so.
- Values outside the token files, such as a theme engine that derives colours in code. List the files it writes, or treat a change to it as a change to everything.
- A `$ref` into another file, such as `other.json#/color/brand/$value`. It is left as written, so a change behind it is not seen. Pass every file with `--tokens`, and point inside the document instead.

Bare camelCase names like `link` also match unrelated words. That selects more, never less; a spelling with its owner, such as `.${camelCase(token)}` or `` `colors.${camelCase(token)}` ``, selects less.

## Licence

[MIT](LICENSE)
