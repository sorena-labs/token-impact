import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "./cli.js";
import { camelCase, changedTokens, findUses, kebabCase, pascalCase, readTokens, resolveTokens, snakeCase } from "./index.js";

/** A new temporary folder holding `files`, by path. */
async function folder(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "token-impact-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  }
  return cwd;
}

describe("readTokens", () => {
  it("names DTCG, Style Dictionary and plain JSON tokens by their path, and skips $ keys", () => {
    const doc = {
      color: { $type: "color", brand: { $value: "#1ba", $type: "color" }, text: { value: "{color.brand}" }, line: "#ccc" },
      size: { base: 16 },
    };
    expect(readTokens(doc)).toEqual({
      default: { "color.brand": "#1ba", "color.text": "{color.brand}", "color.line": "#ccc", "size.base": 16 },
    });
  });

  it("names list items by their name alone", () => {
    const doc = { spacing: { note: "A 4px grid", tokens: [{ name: "space-1", value: "4px", usage: "Gaps" }, "loose"] } };
    expect(readTokens(doc).default).toEqual({ "spacing.note": "A 4px grid", "space-1": "4px", "spacing.tokens.1": "loose" });
  });

  it("splits values by mode and keeps every other value in each mode", () => {
    const doc = {
      brand: { value: { dark: "#1ba", light: "#098" } },
      inverse: { value: { dark: "#fff" } },
      radius: { value: "12px" },
      shadow: { $value: { x: 0, y: 1 } },
    };
    expect(readTokens(doc, { modes: ["dark", "light"] })).toEqual({
      dark: { brand: "#1ba", inverse: "#fff", radius: "12px", shadow: { x: 0, y: 1 } },
      light: { brand: "#098", radius: "12px", shadow: { x: 0, y: 1 } },
    });
  });

  it("reads DTCG root tokens, and groups that extend others", () => {
    const doc = {
      color: { accent: { $root: { $value: "#1ba" }, soft: { $value: "{color.accent.$root}" } } },
      field: { width: { $value: "1px" }, fill: { $value: "#fff", $description: "Base" } },
      input: { $extends: "{field}", width: { $value: "2px" } },
      search: { $extends: { $ref: "#/input" } },
    };
    expect(readTokens(doc).default).toEqual({
      "color.accent.$root": "#1ba",
      "color.accent.soft": "{color.accent.$root}",
      "field.width": "1px",
      "field.fill": "#fff",
      "input.width": "2px",
      "input.fill": "#fff",
      "search.width": "2px",
      "search.fill": "#fff",
    });
  });

  it("throws on a group that extends itself, or extends something that is not a group", () => {
    expect(() => readTokens({ a: { $extends: "{b}" }, b: { $extends: "{a}" } })).toThrow("Circular $extends: a -> b -> a");
    expect(() => readTokens({ button: { secondary: { $extends: "{button}" } } })).toThrow("Circular $extends: button.secondary -> button");
    expect(() => readTokens({ a: { $value: 1 }, b: { $extends: "{a}" } })).toThrow('b extends "{a}", which is not a group.');
  });
});

describe("resolveTokens", () => {
  it("follows chains of aliases, inside strings and composite values too", () => {
    expect(
      resolveTokens({
        brand: "#1ba",
        focus: "{ring}",
        ring: "{brand}",
        edge: "0 0 0 2px {ring}",
        shadow: { color: "{brand}", blur: "{size}" },
        size: 4,
      }),
    ).toEqual({ brand: "#1ba", focus: "#1ba", ring: "#1ba", edge: "0 0 0 2px #1ba", shadow: { color: "#1ba", blur: 4 }, size: 4 });
  });

  it("leaves a reference to a missing token as written, even one named like an object method", () => {
    expect(resolveTokens({ link: "{brand}", edge: "1px solid {line}", odd: "{constructor}" })).toEqual({
      link: "{brand}",
      edge: "1px solid {line}",
      odd: "{constructor}",
    });
  });

  it("throws on a circular reference, naming the loop", () => {
    expect(() => resolveTokens({ a: "{b}", b: "{c}", c: "{a}" })).toThrow("Circular reference: a -> b -> c -> a");
  });

  it("follows $ref JSON Pointers to a value, a part of one, or a whole token, and leaves other files' as written", () => {
    const tokens = readTokens({
      base: { blue: { $value: { components: [0.1, 0.2, 0.3] } }, space: { $value: { value: 4, unit: "px" } } },
      link: { $value: { $ref: "#/base/blue/$value" } },
      red: { $value: { components: [{ $ref: "#/base/blue/$value/components/0" }, 0, 0] } },
      gap: { $value: { value: { $ref: "#/base/space/$value/value" }, unit: "rem" } },
      whole: { $value: { $ref: "#/base/space" } },
      other: { $value: { $ref: "other.json#/base/blue/$value" } },
    }).default!;
    expect(resolveTokens(tokens)).toMatchObject({
      link: { components: [0.1, 0.2, 0.3] },
      red: { components: [0.1, 0, 0] },
      gap: { value: 4, unit: "rem" },
      whole: { value: 4, unit: "px" },
      other: { $ref: "other.json#/base/blue/$value" },
    });
  });
});

describe("changedTokens", () => {
  const modes = { modes: ["dark", "light"] };
  const doc = (tokens: { name: string; value: unknown }[]) => readTokens({ tokens }, modes);

  it("finds own changes, changes through an alias, and added and removed tokens, mode by mode", () => {
    const base = doc([
      { name: "brand", value: { dark: "#1ba", light: "#098" } },
      { name: "brand-text", value: { dark: "{brand}", light: "#076" } },
      { name: "link", value: "{brand-text}" },
      { name: "radius", value: "12px" },
      { name: "hairline", value: "1px" },
    ]);
    const head = doc([
      { name: "brand", value: { dark: "#2cb", light: "#098" } },
      { name: "brand-text", value: { dark: "{brand}", light: "#076" } },
      { name: "link", value: "{brand-text}" },
      { name: "radius", value: "12px" },
      { name: "gap", value: "8px" },
    ]);
    expect(changedTokens(base, head)).toEqual([
      { name: "brand", change: "changed", modes: ["dark"], via: [], before: { dark: "#1ba", light: "#098" }, after: { dark: "#2cb", light: "#098" } },
      { name: "brand-text", change: "changed", modes: ["dark"], via: ["brand"], before: { dark: "#1ba", light: "#076" }, after: { dark: "#2cb", light: "#076" } },
      { name: "link", change: "changed", modes: ["dark"], via: ["brand-text"], before: { dark: "#1ba", light: "#076" }, after: { dark: "#2cb", light: "#076" } },
      { name: "gap", change: "added", modes: ["dark", "light"], via: [], before: {}, after: { dark: "8px", light: "8px" } },
      { name: "hairline", change: "removed", modes: ["dark", "light"], via: [], before: { dark: "1px", light: "1px" }, after: {} },
    ]);
  });

  it("counts a token whose alias changed target as its own change", () => {
    const base = doc([{ name: "a", value: "#111" }, { name: "b", value: "#222" }, { name: "link", value: "{a}" }]);
    const head = doc([{ name: "a", value: "#111" }, { name: "b", value: "#222" }, { name: "link", value: "{b}" }]);
    expect(changedTokens(base, head)).toMatchObject([{ name: "link", change: "changed", via: [] }]);
  });

  it("ignores key order in composite values", () => {
    const base = readTokens({ shadow: { $value: { x: 0, y: 1 } } });
    const head = readTokens({ shadow: { $value: { y: 1, x: 0 } } });
    expect(changedTokens(base, head)).toEqual([]);
  });

  it("names the token a $ref change came through", () => {
    const doc = (blue: string) => readTokens({ blue: { $value: blue }, link: { $value: { $ref: "#/blue/$value" } } });
    expect(changedTokens(doc("#00f"), doc("#11f"))).toMatchObject([
      { name: "blue", via: [] },
      { name: "link", via: ["blue"], after: { default: "#11f" } },
    ]);
  });
});

describe("findUses", () => {
  it("finds whole names only, follows CSS custom properties, and counts unsure files", async () => {
    const cwd = await folder({
      "src/key.css": ".key { --fill: var(--brand); background: var(--fill); }",
      "src/theme.css": ":root { --soft-fill: color-mix(in srgb, var(--fill) 20%, transparent); }",
      "src/panel.css": ".panel { background: var(--soft-fill); }",
      "src/text.css": ".text { color: var(--brand-text); --brand-ish: 1px; }",
      "src/loop.scss": ".x { color: var(--#{$name}); }",
      "lib/key.dart": "final fill = colors.brand;",
      "lib/text.dart": "final ink = colors.brandText;",
      "node_modules/pkg/a.css": "a { color: var(--brand); }",
    });
    const uses = await findUses(
      ["brand", "radius"],
      [
        { files: ["**/*.css", "**/*.scss"], name: (token) => `--${token}`, follow: true, unsure: /var\(--#\{/ },
        { files: ["lib/**/*.dart"], name: camelCase },
      ],
      { cwd },
    );
    expect(uses).toEqual({
      byToken: { brand: ["lib/key.dart", "src/key.css", "src/panel.css", "src/theme.css"], radius: [] },
      unsure: ["src/loop.scss"],
      files: ["lib/key.dart", "src/key.css", "src/loop.scss", "src/panel.css", "src/theme.css"],
    });
  });

  it("takes several spellings, and searches a file once when two globs match it", async () => {
    const cwd = await folder({ "a.ts": `const c = token("brand");`, "b.ts": "const c = 'brand';", "c.ts": "const c = brand;" });
    const uses = await findUses(["brand"], [{ files: ["*.ts", "a.ts"], name: (token) => [`"${token}"`, `'${token}'`] }], { cwd });
    expect(uses.byToken).toEqual({ brand: ["a.ts", "b.ts"] });
  });

  it("counts no unsure file when there is no token to look for", async () => {
    const cwd = await folder({ "loop.scss": ".x { color: var(--#{$name}); }" });
    const uses = await findUses([], [{ files: ["*.scss"], name: (token) => `--${token}`, unsure: /var\(--#\{/ }], { cwd });
    expect(uses).toEqual({ byToken: {}, unsure: [], files: [] });
  });

  it("needs no boundary at an edge that is not a word character", async () => {
    const cwd = await folder({ "a.dart": "colors.brand;", "b.dart": "colors.brandText;", "c.dart": "brand;" });
    const uses = await findUses(["brand"], [{ files: ["*.dart"], name: (token) => `.${camelCase(token)}` }], { cwd });
    expect(uses.byToken).toEqual({ brand: ["a.dart"] });
  });

  it("says when a pattern matches no file, and skips the folders a pattern matches", async () => {
    const cwd = await folder({ "src/a.css": "a { color: var(--brand); }" });
    const rules = (files: string[]) => [{ files, name: (token: string) => `--${token}` }];
    await expect(findUses(["brand"], rules(["src/**/*.css", "scr/**/*.css"]), { cwd })).rejects.toThrow(`No file in ${cwd} matches "scr/**/*.css".`);
    expect((await findUses(["brand"], rules(["src/**"]), { cwd })).byToken).toEqual({ brand: ["src/a.css"] });
  });

  it("counts every unsure file, whatever the pattern's flags", async () => {
    const cwd = await folder({ "a.scss": "var(--#{$a})", "b.scss": "var(--#{$b})" });
    const uses = await findUses(["brand"], [{ files: ["*.scss"], name: (token) => `--${token}`, unsure: /var\(--#\{/g }], { cwd });
    expect(uses.unsure).toEqual(["a.scss", "b.scss"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("stops at a file it cannot read, instead of counting it as unused", async () => {
    const cwd = await folder({ "a.css": "a { color: var(--brand); }" });
    await chmod(join(cwd, "a.css"), 0o000);
    await expect(findUses(["brand"], [{ files: ["*.css"], name: (token) => `--${token}` }], { cwd })).rejects.toThrow("EACCES");
  });
});

describe("case helpers", () => {
  it("split names at separators and case changes", () => {
    const names = ["color.brand-text", "space-1", "fontSize", "text-2xs"];
    expect(names.map(kebabCase)).toEqual(["color-brand-text", "space-1", "font-size", "text-2xs"]);
    expect(names.map(camelCase)).toEqual(["colorBrandText", "space1", "fontSize", "text2xs"]);
    expect(names.map(pascalCase)).toEqual(["ColorBrandText", "Space1", "FontSize", "Text2xs"]);
    expect(names.map(snakeCase)).toEqual(["color_brand_text", "space_1", "font_size", "text_2xs"]);
  });
});

const tokens = (brand: string, line = "#ccc") =>
  JSON.stringify({ color: { brand: { $value: brand }, text: { $value: "{color.brand}" }, line: { $value: line } } });

/** A git repository with `files` committed on main. */
async function repo(files: Record<string, string>): Promise<{ cwd: string; git: (...args: string[]) => string }> {
  const cwd = await folder(files);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("add", ".");
  git("commit", "--quiet", "--message", "Base");
  return { cwd, git };
}

describe("token-impact", () => {
  it("lists the tokens changed since HEAD, with their values and the files that use them", async () => {
    const { cwd } = await repo({
      "tokens.json": tokens("#1ba"),
      "src/link.css": "a { color: var(--color-text); }",
      "src/rule.css": "hr { border-color: var(--color-line); }",
    });
    await writeFile(join(cwd, "tokens.json"), tokens("#2cb"));
    expect(await run(["--tokens", "tokens.json", "--css", "src/**/*.css"], cwd)).toBe(
      [
        "2 tokens changed, used in 1 file.",
        "",
        "color.brand  changed",
        "  #1ba -> #2cb",
        "  Not used in the searched files.",
        "",
        "color.text  changed via color.brand",
        "  #1ba -> #2cb",
        "  Used in 1 file:",
        "    src/link.css",
        "",
      ].join("\n"),
    );
    expect(await run(["--tokens", "tokens.json", "--css", "src/**/*.css", "--files"], cwd)).toBe("src/link.css\n");
    const json = JSON.parse(await run(["--tokens", "tokens.json", "--json"], cwd));
    expect(json.changes.map((change: { name: string }) => change.name)).toEqual(["color.brand", "color.text"]);
  });

  it("labels each mode that changed, and writes a change made in every mode once", async () => {
    const doc = (dark: string, radius: string) =>
      JSON.stringify({ tokens: [{ name: "brand", value: { dark, light: "#098" } }, { name: "radius", value: radius }] });
    const { cwd } = await repo({ "tokens.json": doc("#1ba", "12px") });
    await writeFile(join(cwd, "tokens.json"), doc("#2cb", "14px"));
    expect(await run(["--tokens", "tokens.json", "--modes", "dark,light"], cwd)).toBe(
      ["2 tokens changed.", "", "brand  changed", "  dark  #1ba -> #2cb", "", "radius  changed", "  12px -> 14px", ""].join("\n"),
    );
  });

  it("compares with where the branch left --base, so changes made there since are not counted", async () => {
    const { cwd, git } = await repo({ "tokens.json": tokens("#1ba") });
    git("switch", "--quiet", "--create", "feature");
    git("switch", "--quiet", "main");
    await writeFile(join(cwd, "tokens.json"), tokens("#1ba", "#ddd"));
    git("commit", "--quiet", "--all", "--message", "Change the line on main");
    git("switch", "--quiet", "feature");
    await writeFile(join(cwd, "tokens.json"), tokens("#2cb"));
    const json = JSON.parse(await run(["--tokens", "tokens.json", "--base", "main", "--json"], cwd));
    expect(json.changes.map((change: { name: string }) => change.name)).toEqual(["color.brand", "color.text"]);
  });

  it("finds a DTCG root token by its name with and without $root", async () => {
    const doc = (accent: string) => JSON.stringify({ color: { accent: { $root: { $value: accent }, soft: { $value: "{color.accent.$root}" } } } });
    const { cwd } = await repo({
      "tokens.json": doc("#1ba"),
      "a.css": "a { color: var(--color-accent); }",
      "b.css": "b { color: var(--color-accent-root); }",
      "c.css": "c { color: var(--color-accent-soft); }",
    });
    await writeFile(join(cwd, "tokens.json"), doc("#2cb"));
    expect(await run(["--tokens", "tokens.json", "--css", "*.css", "--files"], cwd)).toBe("a.css\nb.css\nc.css\n");
  });

  it("with --check, prints the output and then fails when a removed token is still used", async () => {
    const { cwd } = await repo({
      "tokens.json": tokens("#1ba"),
      "src/link.css": "a { color: var(--color-text); }",
      "src/rule.css": "hr { border-color: var(--color-line); }",
    });
    const args = ["--tokens", "tokens.json", "--css", "src/**/*.css", "--check"];
    await writeFile(join(cwd, "tokens.json"), JSON.stringify({ color: { brand: { $value: "#1ba" }, text: { $value: "{color.brand}" } } }));
    const failed = run([...args, "--files"], cwd);
    await expect(failed).rejects.toThrow("Removed tokens that are still used:\n  color.line  in 1 file");
    await expect(failed).rejects.toMatchObject({ output: "src/rule.css\n" });

    await writeFile(join(cwd, "src/rule.css"), "hr { border-color: gray; }");
    expect(await run(args, cwd)).toBe(["1 token changed, used in 0 files.", "", "color.line  removed", "  #ccc", "  Not used in the searched files.", ""].join("\n"));
    await expect(run(["--tokens", "tokens.json", "--check"], cwd)).rejects.toThrow("--check needs a file option");
  });

  it("counts every token as added when the file is new", async () => {
    const { cwd } = await repo({ "README.md": "" });
    await writeFile(join(cwd, "tokens.json"), tokens("#1ba"));
    const json = JSON.parse(await run(["--tokens", "tokens.json", "--json"], cwd));
    expect(json.changes.map((change: { change: string }) => change.change)).toEqual(["added", "added", "added"]);
  });

  it("says what to do when the input is wrong", async () => {
    const { cwd } = await repo({ "tokens.json": tokens("#1ba") });
    await expect(run([], cwd)).rejects.toThrow("Pass a token file with --tokens");
    await expect(run(["--tokens", "tokens.json", "--base", "nope"], cwd)).rejects.toThrow('"nope" is not a commit here');
    await writeFile(join(cwd, "tokens.json"), "{");
    await expect(run(["--tokens", "tokens.json"], cwd)).rejects.toThrow("tokens.json is not valid JSON");
    expect(await run(["--help"], cwd)).toContain("Usage: token-impact");
  });
});
