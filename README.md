# token-impact

Lists the design tokens a change touches, and the files that use them.

Change one token and every screen that uses it can look different. Most visual test setups only know that the token file changed, so they capture every screenshot again. token-impact reads the token file before and after the change, resolves every alias in every mode, and lists the tokens whose final value changed, including tokens that changed only because an alias they point at did. Then it finds the CSS, Dart, Swift, Kotlin or TypeScript files that use them, so you rerun only the tests and screenshots those files feed, and a reviewer sees what changed.

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
| `--tokens <file>` | A token file: DTCG, Style Dictionary or plain JSON. Repeat for several; later files win. |
| `--base <commit>` | The commit to compare with. Default `HEAD`. |
| `--modes <list>` | Mode names, comma separated, such as `dark,light`. |
| `--css <glob>` | Files that use tokens as CSS custom properties: `--color-brand`. |
| `--scss <glob>` | Files that use tokens as Sass variables: `$color-brand`. |
| `--camel <glob>` | Files that use camelCase names: `colorBrand` (Dart, Swift, Kotlin, JS). |
| `--pascal <glob>` | Files that use PascalCase names: `ColorBrand`. |
| `--snake <glob>` | Files that use snake_case names: `color_brand` (Android resources). |
| `--string <glob>` | Files that use the token name in quotes: `"color.brand"`. |
| `--json` | Print the changes and the uses as JSON. |
| `--files` | Print only the files that use a changed token, one per line. |

Repeat a file option for several globs, and quote each glob so the shell leaves it alone. `node_modules` and `.git` are skipped.

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
- Lists: an item with `name` and `value` (or `$value`) is a token named by its `name` alone.
- Plain nested JSON: any other string, number or boolean is a token, named by its path.
- Keys that start with `$` (`$type`, `$description`) are skipped.

With `modes`, a value that is an object with only those keys holds one value per mode: `{ "dark": "#2f6fde", "light": "#1f5bc4" }`. Any other value is the same in every mode. If your modes live in separate files, read each file and merge the maps yourself:

```ts
const dark = { ...readTokens(core).default, ...readTokens(darkDoc).default };
const light = { ...readTokens(core).default, ...readTokens(lightDoc).default };
changedTokens(baseModes, { dark, light });
```

### `changedTokens(base, head)`

The tokens whose resolved value changed in any mode, in document order with removed tokens last. Each change has:

- `name`
- `change`: `"added"`, `"removed"` or `"changed"`
- `modes`: the modes whose resolved value changed
- `via`: when the token's own value is the same, the tokens it points at that changed
- `before`, `after`: the resolved value in each mode

Values are compared by content, so reordering the keys of a composite value is not a change.

### `findUses(tokens, rules, { cwd? })`

Finds the files that use each token. A rule has:

- `files`: glob patterns, relative to `cwd`
- `name(token)`: how a token is written in those files, one spelling or several
- `follow`: CSS only. With `--fill: var(--color-brand)` anywhere in the rule's files, every use of `--fill` counts as a use of `color.brand` too, through any number of steps.
- `unsure`: a pattern for files that read tokens in a way that cannot be followed, such as `/var\(--#\{/` for Sass interpolation. Those files count as using every token.

It returns `byToken` (the files for each token), `unsure` and `files` (every file once), all sorted, with `/` separators.

Names match as whole words: `--color-brand` is not found inside `--color-brand-text`, nor `colorBrand` inside `colorBrandText`. A spelling that starts or ends with a character that is not part of a name, such as the dot in `.colorBrand`, matches next to anything.

### `resolveTokens(tokens)`

Replaces every `{alias}` in one mode's map with the value it points at, through any number of steps, including aliases inside strings (`"0 0 0 2px {color.focus}"`) and inside composite values. A reference to a missing token is left as written; a circular one throws and names the loop.

### `kebabCase`, `camelCase`, `pascalCase`, `snakeCase`

The usual spellings of a token name, split at any separator and where lower case turns to upper: `color.brand-text` becomes `color-brand-text`, `colorBrandText`, `ColorBrandText` and `color_brand_text`.

## What it can miss

- A token whose name is built at run time, such as `` `var(--${name})` ``. Mark those files with `unsure`.
- A spelling you did not give. If your generated code spells `color.brand` as `AppColors.primary`, pass a `name` that says so.
- Values outside the token files, such as a theme engine that derives colours in code. List the files it writes, or treat a change to it as a change to everything.

Bare camelCase names like `link` also match unrelated words. That selects more, never less; a spelling with its owner, such as `.${camelCase(token)}` or `` `colors.${camelCase(token)}` ``, selects less.

## Licence

MIT
