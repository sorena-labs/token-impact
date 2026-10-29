import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  camelCase,
  changedTokens,
  findUses,
  kebabCase,
  pascalCase,
  readTokens,
  snakeCase,
  type TokenChange,
  type Tokens,
  type UseRule,
  type Uses,
} from "./index.js";

/** How each file option spells a token. */
const STYLES = {
  css: { name: (token) => `--${kebabCase(token)}`, follow: true },
  scss: { name: (token) => `$${kebabCase(token)}` },
  camel: { name: camelCase },
  pascal: { name: pascalCase },
  snake: { name: snakeCase },
  string: { name: (token) => [`"${token}"`, `'${token}'`, `\`${token}\``] },
} satisfies Record<string, Omit<UseRule, "files">>;

export const USAGE = `Usage: token-impact --tokens <file> [options]

Lists the design tokens whose resolved value changed since a commit, and the files that use them.

Options:
  --tokens <file>   A JSON token file: DTCG, Style Dictionary or plain JSON. Repeat for several.
  --base <commit>   Compare with the commit where this branch left <commit>. Default: HEAD.
  --modes <list>    Mode names, comma separated, such as dark,light.
  --css <glob>      Files that use tokens as CSS custom properties: --color-brand,
                    and properties set from them, such as --fill: var(--color-brand).
  --scss <glob>     Files that use tokens as Sass variables: $color-brand.
  --camel <glob>    Files that use camelCase names: colorBrand (Dart, Swift, Kotlin, JS).
  --pascal <glob>   Files that use PascalCase names: ColorBrand.
  --snake <glob>    Files that use snake_case names: color_brand (Android resources).
  --string <glob>   Files that use the token name in quotes: "color.brand".
  --json            Print { changes, uses } as JSON.
  --files           Print only the files that use a changed token, one per line.
  --help            Show this help.

Repeat a file option for several globs, and quote each glob so the shell leaves it alone.
`;

/** Runs the command line in `cwd` and returns what it prints. */
export async function run(args: string[], cwd = process.cwd()): Promise<string> {
  const files = { type: "string", multiple: true } as const;
  const { values } = parseArgs({
    args,
    options: {
      tokens: files,
      base: { type: "string", default: "HEAD" },
      modes: { type: "string" },
      css: files,
      scss: files,
      camel: files,
      pascal: files,
      snake: files,
      string: files,
      json: { type: "boolean" },
      files: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return USAGE;
  if (!values.tokens?.length) throw new Error("Pass a token file with --tokens. Run with --help for every option.");

  const git = (...gitArgs: string[]) => execFileSync("git", gitArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("rev-parse", "--verify", "--quiet", `${values.base}^{commit}`);
  } catch {
    throw new Error(`"${values.base}" is not a commit here. Run inside the git repository, and fetch the commit first.`);
  }
  let base = values.base;
  try {
    base = git("merge-base", base, "HEAD").trim();
  } catch {
    // No common history: compare with the commit itself.
  }

  const modes = values.modes?.split(",").map((mode) => mode.trim()).filter(Boolean);
  const read = (texts: [file: string, text: string | undefined][]) => {
    const byMode: Record<string, Tokens> = {};
    for (const [file, text] of texts) {
      let doc: unknown = {};
      try {
        if (text !== undefined) doc = JSON.parse(text);
      } catch (error) {
        throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
      }
      for (const [mode, tokens] of Object.entries(readTokens(doc, { modes }))) Object.assign((byMode[mode] ??= {}), tokens);
    }
    return byMode;
  };
  const baseText = (file: string) => {
    try {
      return git("show", `${base}:./${relative(cwd, resolve(cwd, file)).split(sep).join("/")}`);
    } catch {
      return undefined; // Not in the base commit: every token in it is new.
    }
  };
  const changes = changedTokens(
    read(values.tokens.map((file) => [`${file} at ${values.base}`, baseText(file)])),
    read(values.tokens.map((file) => [file, readFileSync(resolve(cwd, file), "utf8")])),
  );

  const rules = (Object.keys(STYLES) as (keyof typeof STYLES)[]).flatMap((style) =>
    values[style]?.length ? [{ files: values[style], ...STYLES[style] }] : [],
  );
  const uses = await findUses(
    changes.map((change) => change.name),
    rules,
    { cwd },
  );

  if (values.json) return `${JSON.stringify({ changes, uses }, null, 2)}\n`;
  if (values.files) return uses.files.map((file) => `${file}\n`).join("");
  return report(changes, uses, rules.length > 0);
}

/** The changes as a reviewer reads them: each token, its values before and after, and the files that use it. */
function report(changes: TokenChange[], uses: Uses, searched: boolean): string {
  if (changes.length === 0) return "No tokens changed.\n";
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
  const lines = [`${count(changes.length, "token")} changed${searched ? `, used in ${count(uses.files.length, "file")}` : ""}.`];

  for (const change of changes) {
    lines.push("", `${change.name}  ${change.change}${change.via.length ? ` via ${change.via.join(", ")}` : ""}`);
    const values = change.modes.map((mode) => {
      const [before, after] = [change.before[mode], change.after[mode]];
      return change.change === "changed" ? `${show(before)} -> ${show(after)}` : show(before ?? after);
    });
    const allModes = new Set([...Object.keys(change.before), ...Object.keys(change.after)]);
    if (change.modes.length === allModes.size && new Set(values).size === 1) {
      lines.push(`  ${values[0]}`); // The same in every mode, or there is only one.
    } else {
      const width = Math.max(...change.modes.map((mode) => mode.length));
      change.modes.forEach((mode, index) => lines.push(`  ${mode.padEnd(width)}  ${values[index]}`));
    }
    const files = uses.byToken[change.name] ?? [];
    if (files.length) lines.push(`  Used in ${count(files.length, "file")}:`, ...files.map((file) => `    ${file}`));
    else if (searched) lines.push("  Not used in the searched files.");
  }
  if (uses.unsure.length) {
    lines.push("", "These files read tokens in a way that cannot be followed, so they count as using every token:");
    lines.push(...uses.unsure.map((file) => `  ${file}`));
  }
  return `${lines.join("\n")}\n`;
}
