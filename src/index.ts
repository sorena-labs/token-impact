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
    if (isToken(node)) {
      flat[path.join(".")] = "$value" in node ? node.$value : node.value;
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => {
        if (isToken(item) && typeof item.name === "string") {
          flat[item.name] = "$value" in item ? item.$value : item.value;
        } else visit(item, [...path, String(index)]);
      });
    } else if (isObject(node)) {
      // `$root` is the group's own token; every other `$` key describes the group.
      for (const [key, child] of Object.entries(extend(doc, node, path))) if (!key.startsWith("$") || key === "$root") visit(child, [...path, key]);
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

/**
 * A DTCG group with the tokens of the group its `$extends` names merged in. Groups merge; a token of its own
 * replaces an inherited one whole.
 */
function extend(doc: unknown, group: Record<string, unknown>, path: string[], chain: string[] = []): Record<string, unknown> {
  const ref = group.$extends;
  if (ref === undefined) return group;
  const target =
    typeof ref === "string" ? WHOLE_REF.exec(ref)?.[1]!.split(".") : isObject(ref) && typeof ref.$ref === "string" ? pointerPath(ref.$ref) : undefined;
  const base = target?.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), doc);
  const name = path.join(".");
  if (!target || !isGroup(base)) throw new Error(`${name} extends ${JSON.stringify(ref)}, which is not a group.`);
  // Extending a group it is part of would nest it in itself without end.
  if (chain.includes(target.join(".")) || target.every((key, index) => path[index] === key)) {
    throw new Error(`Circular $extends: ${[...chain, name, target.join(".")].join(" -> ")}`);
  }
  return merge(extend(doc, base, target, [...chain, name]), group);
}

function merge(base: Record<string, unknown>, own: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(own)) {
    const inherited = merged[key];
    merged[key] = isGroup(inherited) && isGroup(value) ? merge(inherited, value) : value;
  }
  return merged;
}

/** `#/color/brand` to `["color", "brand"]`. Undefined for a pointer into another file. */
function pointerPath(pointer: string): string[] | undefined {
  if (!pointer.startsWith("#/")) return undefined;
  return pointer.slice(2).split("/").map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** The name of the token a `$ref` points into, and the keys inside its value: `#/a/b/$value/0` is `a.b` and `["0"]`. */
function pointed(pointer: string): [name: string, keys: string[]] | undefined {
  const path = pointerPath(pointer);
  if (!path) return undefined;
  const at = path.includes("$value") ? path.indexOf("$value") : path.length;
  return [path.slice(0, at).join("."), path.slice(at + 1)];
}

const REF = /\{([^{}]+)\}/g;
const WHOLE_REF = /^\{([^{}]+)\}$/;

/**
 * Replaces every `{alias}` and `{ "$ref": "#/json/pointer" }` with the value it points at, through any number
 * of steps. A reference to a missing token or another file is left as written; a circular one throws.
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
    if (isObject(raw) && typeof raw.$ref === "string") {
      const target = pointed(raw.$ref);
      if (!target || !Object.hasOwn(tokens, target[0])) return raw;
      return target[1].reduce<unknown>((node, key) => (isObject(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined), value(target[0]));
    }
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
  /** When the token's own value is the same, the tokens it points at directly that changed. Empty otherwise. */
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
      const json = JSON.stringify(rawAfter);
      const refs = [...json.matchAll(REF)].map((match) => match[1]!);
      const pointers = [...json.matchAll(/"\$ref":"([^"]+)"/g)].flatMap((match) => pointed(match[1]!)?.[0] ?? []);
      change.via = [...new Set([...refs, ...pointers])].filter((ref) => changed.has(ref));
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
  /** Files matched by a rule's `unsure` pattern: they count as using every token, and are in `byToken` only under the tokens they name. Empty when no token was passed. */
  unsure: string[];
  /** Every file above, once, sorted. */
  files: string[];
}

/**
 * Finds the files that use each of `tokens`, as each rule spells them. It searches the text, so a name in a comment counts too.
 * A pattern that matches no file, or a file it cannot read, throws: either would hide uses.
 */
export async function findUses(tokens: string[], rules: UseRule[], { cwd = process.cwd() } = {}): Promise<Uses> {
  const byToken: Record<string, Set<string>> = Object.fromEntries(tokens.map((token) => [token, new Set<string>()]));
  const unsure = new Set<string>();
  const exclude = (path: string) => /(^|[\\/])(node_modules|\.git)$/.test(path);
  const read = new Map<string, string | undefined>(); // Every file read so far, by path, for all rules. Undefined for a folder.
  for (const rule of rules) {
    const matched = new Map<string, string[]>();
    for (const pattern of rule.files) {
      const files: string[] = [];
      for await (const path of glob(pattern, { cwd, exclude })) files.push(path.split(sep).join("/"));
      matched.set(pattern, files);
    }
    const files = [...new Set([...matched.values()].flat())];
    const queue = files.filter((file) => !read.has(file));
    // A few reads at a time: enough to keep the disk busy, too few to run out of file handles.
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        for (let file = queue.pop(); file !== undefined; file = queue.pop()) read.set(file, await readText(join(cwd, file)));
      }),
    );
    for (const [pattern, files] of matched) {
      if (!files.some((file) => read.get(file) !== undefined)) throw new Error(`No file in ${cwd} matches "${pattern}".`);
    }
    const texts = new Map(files.flatMap((file) => (read.get(file) === undefined ? [] : [[file, read.get(file)!] as const])));

    // With no tokens to look for, no file can use one, however it reads them.
    if (rule.unsure && tokens.length) {
      // Without g or y, test() starts at the beginning of each file instead of where the last match ended.
      const pattern = new RegExp(rule.unsure.source, rule.unsure.flags.replace(/[gy]/g, ""));
      for (const [file, text] of texts) if (pattern.test(text)) unsure.add(file);
    }

    const inFiles = search(texts);
    const declarations = rule.follow
      ? [...texts.values()].flatMap((text) => [...text.matchAll(/(--[\w-]+)\s*:([^;{}]*)/g)].map(([, property, value]) => [property!, value!] as const))
      : [];
    const inValues = search(new Map(declarations.map((declaration) => [declaration, declaration[1]])));
    for (const token of tokens) {
      const spellings = new Set([rule.name(token)].flat());
      // A custom property set from a spelling is one more spelling, so the set grows while it is walked.
      if (rule.follow) for (const spelling of spellings) for (const [property] of inValues(spelling)) spellings.add(property);
      for (const spelling of spellings) for (const file of inFiles(spelling)) byToken[token]!.add(file);
    }
  }
  const sorted = (files: Iterable<string>) => [...files].sort();
  return {
    byToken: Object.fromEntries(Object.entries(byToken).map(([token, files]) => [token, sorted(files)])),
    unsure: sorted(unsure),
    files: sorted(new Set([...unsure, ...Object.values(byToken).flatMap((files) => [...files])])),
  };
}

/** A file's text, or undefined for a folder, or for a file removed or a link broken since the search found it. */
function readText(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EISDIR" || error.code === "ENOENT") return undefined;
    throw error;
  });
}

const DASHED_NAMES = /[A-Za-z0-9_-]+/g;
const NAMES = /[A-Za-z0-9_]+/g;
/** The names a spelling is matched among, made of the characters `word` draws its edges at. */
const namesLike = (spelling: string) => (spelling.includes("-") ? DASHED_NAMES : NAMES);

/**
 * Indexes `texts` by the names in them, and returns a search for the keys of the texts that hold a spelling as
 * `word` matches it. Wherever a spelling matches, every name in it is a whole name in the text, so only the
 * texts holding its longest name need testing.
 */
function search<K>(texts: Map<K, string>): (spelling: string) => K[] {
  const indexes = new Map<RegExp, Map<string, K[]>>();
  const index = (names: RegExp) => {
    let byName = indexes.get(names);
    if (!byName) {
      indexes.set(names, (byName = new Map()));
      for (const [key, text] of texts) {
        for (const name of new Set(text.match(names))) {
          const keys = byName.get(name);
          if (keys) keys.push(key);
          else byName.set(name, [key]);
        }
      }
    }
    return byName;
  };
  return (spelling) => {
    const names = namesLike(spelling);
    const longest = (spelling.match(names) ?? []).reduce((a, b) => (b.length > a.length ? b : a), "");
    const keys = longest ? (index(names).get(longest) ?? []) : [...texts.keys()];
    if (longest === spelling) return keys; // The spelling is one whole name, so holding it is matching it.
    const pattern = word(spelling);
    return keys.filter((key) => pattern.test(texts.get(key)!));
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

function isToken(value: unknown): value is Record<string, unknown> {
  return isObject(value) && ("$value" in value || "value" in value);
}

function isGroup(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !isToken(value);
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
