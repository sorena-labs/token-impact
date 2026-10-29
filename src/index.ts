import { readFile, glob } from "node:fs/promises";
import { join, sep } from "node:path";

/** One mode's tokens by name, raw: `{alias}` references are left as written. */
export type Tokens = Record<string, unknown>;

export interface ReadOptions {
  /**
   * Mode names, such as `["dark", "light"]`. A value that is an object with only these keys holds one
   * value per mode; any other value is the same in every mode.
   */
  modes?: string[];
}

/**
 * Flattens a token document into one `Tokens` per mode, keyed by mode. Without `modes` the only mode is
 * `"default"`.
 *
 * - DTCG: an object with `$value` is a token, named by its path (`color.brand`).
 * - Style Dictionary: an object with `value` is a token, named by its path.
 * - Lists: an item with `name` and `value` (or `$value`) is a token named by its `name` alone.
 * - Plain nested JSON: any other string, number or boolean is a token, named by its path.
 *
 * Keys that start with `$` (`$type`, `$description`) are skipped.
 */
export function readTokens(doc: unknown, { modes = [] }: ReadOptions = {}): Record<string, Tokens> {
  const flat: Tokens = {};
  const visit = (node: unknown, path: string[]): void => {
    if (isObject(node) && ("$value" in node || "value" in node)) {
      flat[path.join(".")] = "$value" in node ? node.$value : node.value;
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => {
        if (isObject(item) && typeof item.name === "string" && ("$value" in item || "value" in item)) {
          flat[item.name] = "$value" in item ? item.$value : item.value;
        } else visit(item, [...path, String(index)]);
      });
    } else if (isObject(node)) {
      for (const [key, child] of Object.entries(node)) if (!key.startsWith("$")) visit(child, [...path, key]);
    } else if (node !== null && node !== undefined && path.length > 0) {
      flat[path.join(".")] = node;
    }
  };
  visit(doc, []);

  if (modes.length === 0) return { default: flat };
  const byMode: Record<string, Tokens> = Object.fromEntries(modes.map((mode) => [mode, {}]));
  for (const [name, value] of Object.entries(flat)) {
    const moded = isObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => modes.includes(key));
    for (const mode of modes) {
      if (!moded) byMode[mode]![name] = value;
      else if (Object.hasOwn(value, mode)) byMode[mode]![name] = value[mode];
    }
  }
  return byMode;
}

const REF = /\{([^{}]+)\}/g;
const WHOLE_REF = /^\{([^{}]+)\}$/;

/**
 * Replaces every `{alias}` with the value it points at, through any number of steps. A reference to a
 * missing token is left as written; a circular one throws.
 */
export function resolveTokens(tokens: Tokens): Tokens {
  const done = new Map<string, unknown>();
  const path: string[] = [];
  const value = (name: string): unknown => {
    if (done.has(name)) return done.get(name);
    if (path.includes(name)) throw new Error(`Circular reference: ${[...path.slice(path.indexOf(name)), name].join(" -> ")}`);
    path.push(name);
    const resolved = walk(tokens[name]);
    path.pop();
    done.set(name, resolved);
    return resolved;
  };
  const walk = (raw: unknown): unknown => {
    if (typeof raw === "string") {
      const whole = WHOLE_REF.exec(raw)?.[1];
      if (whole !== undefined) return Object.hasOwn(tokens, whole) ? value(whole) : raw;
      return raw.replace(REF, (ref, name: string) => {
        if (!Object.hasOwn(tokens, name)) return ref;
        const resolved = value(name);
        return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
      });
    }
    if (Array.isArray(raw)) return raw.map(walk);
    if (isObject(raw)) return Object.fromEntries(Object.entries(raw).map(([key, child]) => [key, walk(child)]));
    return raw;
  };
  return Object.fromEntries(Object.keys(tokens).map((name) => [name, value(name)]));
}

export interface TokenChange {
  name: string;
  change: "added" | "removed" | "changed";
  /** The modes whose resolved value changed. */
  modes: string[];
  /** When the token's own value is the same, the tokens it points at that changed. Empty otherwise. */
  via: string[];
  /** The resolved value in each mode before the change. Modes the token is missing from are left out. */
  before: Record<string, unknown>;
  /** The resolved value in each mode after the change. */
  after: Record<string, unknown>;
}

/**
 * The tokens whose resolved value changed in any mode between two `readTokens` results, including tokens
 * that changed only because a token they point at did. In document order, removed tokens last.
 */
export function changedTokens(base: Record<string, Tokens>, head: Record<string, Tokens>): TokenChange[] {
  const modes = [...new Set([...Object.keys(base), ...Object.keys(head)])];
  const resolve = (side: Record<string, Tokens>) =>
    Object.fromEntries(Object.entries(side).map(([mode, tokens]) => [mode, resolveTokens(tokens)]));
  const [baseValues, headValues] = [resolve(base), resolve(head)];
  const pick = (side: Record<string, Tokens>, name: string) =>
    Object.fromEntries(modes.filter((mode) => side[mode] && Object.hasOwn(side[mode], name)).map((mode) => [mode, side[mode]![name]]));

  const names = new Set<string>();
  for (const side of [head, base]) for (const tokens of Object.values(side)) for (const name of Object.keys(tokens)) names.add(name);

  const changes: TokenChange[] = [];
  for (const name of names) {
    const before = pick(baseValues, name);
    const after = pick(headValues, name);
    const changedModes = modes.filter((mode) => !same(before[mode], after[mode]));
    if (changedModes.length === 0) continue;
    const change = !Object.keys(before).length ? "added" : !Object.keys(after).length ? "removed" : "changed";
    changes.push({ name, change, modes: changedModes, via: [], before, after });
  }

  const changed = new Set(changes.map((change) => change.name));
  for (const change of changes) {
    const rawAfter = pick(head, change.name);
    if (change.change === "changed" && same(pick(base, change.name), rawAfter)) {
      const refs = [...JSON.stringify(rawAfter).matchAll(REF)].map((match) => match[1]!);
      change.via = [...new Set(refs)].filter((ref) => changed.has(ref));
    }
  }
  return changes.sort((a, b) => Number(a.change === "removed") - Number(b.change === "removed"));
}

export interface UseRule {
  /** Glob patterns of the files to search, relative to `cwd`. `node_modules` and `.git` are skipped. */
  files: string[];
  /** How a token is written in these files, such as `(token) => "--" + kebabCase(token)`. Several spellings as an array. */
  name: (token: string) => string | string[];
  /**
   * CSS only: follow custom properties set from a token, so that with `--fill: var(--brand)` anywhere in
   * these files, every use of `--fill` is a use of `brand` too. Selectors are ignored, so this selects more.
   */
  follow?: boolean;
  /** A file whose text matches reads tokens in a way that cannot be followed, so it counts as using every token. */
  unsure?: RegExp;
}

export interface Uses {
  /** The files that use each token, sorted, as paths relative to `cwd` with `/` separators. */
  byToken: Record<string, string[]>;
  /** Files matched by a rule's `unsure` pattern: they count as using every token. */
  unsure: string[];
  /** Every file above, once, sorted. */
  files: string[];
}

/** Finds the files that use each of `tokens`, as each rule spells them. */
export async function findUses(tokens: string[], rules: UseRule[], { cwd = process.cwd() } = {}): Promise<Uses> {
  const byToken: Record<string, Set<string>> = Object.fromEntries(tokens.map((token) => [token, new Set<string>()]));
  const unsure = new Set<string>();
  const exclude = (path: string) => /(^|[\\/])(node_modules|\.git)$/.test(path);
  for (const rule of rules) {
    const texts = new Map<string, string>();
    for await (const path of glob(rule.files, { cwd, exclude })) {
      const file = path.split(sep).join("/");
      if (!texts.has(file)) texts.set(file, await readFile(join(cwd, path), "utf8").catch(() => ""));
    }
    if (rule.unsure) for (const [file, text] of texts) if (rule.unsure.test(text)) unsure.add(file);

    for (const token of tokens) {
      const spellings = [rule.name(token)].flat();
      const patterns = spellings.map(word);
      // Each pass adds the custom properties set from a spelling found so far, until none are new.
      for (let added = Boolean(rule.follow); added; ) {
        added = false;
        for (const text of texts.values()) {
          for (const [, property, value] of text.matchAll(/(--[\w-]+)\s*:([^;{}]*)/g)) {
            if (!spellings.includes(property!) && patterns.some((pattern) => pattern.test(value!))) {
              spellings.push(property!);
              patterns.push(word(property!));
              added = true;
            }
          }
        }
      }
      for (const [file, text] of texts) if (patterns.some((pattern) => pattern.test(text))) byToken[token]!.add(file);
    }
  }
  const sorted = (files: Iterable<string>) => [...files].sort();
  return {
    byToken: Object.fromEntries(Object.entries(byToken).map(([token, files]) => [token, sorted(files)])),
    unsure: sorted(unsure),
    files: sorted(new Set([...unsure, ...Object.values(byToken).flatMap((files) => [...files])])),
  };
}

/**
 * Matches `spelling` as a whole word: `--brand` is not found inside `--brand-text`, nor `brand` inside
 * `brandText`. An edge that is not a word character (the dot of `.brand`, a quote) needs no boundary.
 */
function word(spelling: string): RegExp {
  const part = spelling.includes("-") ? "[A-Za-z0-9_-]" : "[A-Za-z0-9_]";
  const isPart = (char = "") => new RegExp(`^${part}$`).test(char);
  const before = isPart(spelling[0]) ? `(?<!${part})` : "";
  const after = isPart(spelling.at(-1)) ? `(?!${part})` : "";
  return new RegExp(`${before}${spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${after}`);
}

/** The words of a token name, split at any separator and where lower case turns to upper. */
function words(name: string): string[] {
  return name
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}
const capital = (part: string) => part.charAt(0).toUpperCase() + part.slice(1);

/** `color.brand-text` to `color-brand-text`. */
export const kebabCase = (name: string): string => words(name).join("-");
/** `color.brand-text` to `colorBrandText`. */
export const camelCase = (name: string): string => words(name).map((part, index) => (index ? capital(part) : part)).join("");
/** `color.brand-text` to `ColorBrandText`. */
export const pascalCase = (name: string): string => words(name).map(capital).join("");
/** `color.brand-text` to `color_brand_text`. */
export const snakeCase = (name: string): string => words(name).join("_");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep equality for JSON values, whatever the key order. */
function same(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : isObject(value)
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
