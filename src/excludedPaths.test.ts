import { excludedPathMatcher, assertNotExcluded, ExcludedPathError, ConfigDirAccessError } from "./vaultPath";
import { App, TFile } from "../mocks/obsidian";
import { VaultOperations } from "./vaultOperations";
import { LocalRestApiSettings } from "./types";

describe("excludedPathMatcher", () => {
  const m = excludedPathMatcher(["Resources/Private/**", "**/*.secret.md", "Journal"]);

  test.each([
    ["Resources/Private/Hộ chiếu.md", true],
    ["Resources/Private", true],
    ["Resources/Private/", true],
    ["Resources/Private/deep/x.md", true],
    // APFS/NTFS compare names case-insensitively and NFC/NFD-insensitively.
    ["resources/PRIVATE/x.md", true],
    ["Resources/Private/Hộ chiếu.md".normalize("NFD"), true],
    // Resolved before matching, so dot segments do not slip past.
    ["Resources/Public/../Private/x.md", true],
    ["Resources/./Private/x.md", true],
    ["Resources\\Private\\x.md", true],
    ["Resources/Private./x.md", true],
    ["a/b/c.secret.md", true],
    ["c.secret.md", true],
    ["Journal", true],
    ["Journal/2026.md", true],
    // Near misses stay visible.
    ["Resources/PrivateNotes.md", false],
    ["Resources/Privacy/x.md", false],
    ["Resources", false],
    ["", false],
    ["Journals/x.md", false],
    ["secret.md", false],
  ])("%s → %s", (path, expected) => {
    expect(m(path)).toBe(expected);
  });

  test("an empty or absent list excludes nothing", () => {
    expect(excludedPathMatcher(undefined)("Resources/Private/x.md")).toBe(false);
    expect(excludedPathMatcher(["  ", ""])("x.md")).toBe(false);
  });

  test("refusals are ConfigDirAccessErrors, so every existing gate lets them through", () => {
    expect(() => assertNotExcluded("Resources/Private/x.md", ["Resources/Private/**"])).toThrow(
      ExcludedPathError,
    );
    try {
      assertNotExcluded("Resources/Private/x.md", ["Resources/Private/**"]);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigDirAccessError);
    }
  });
});

describe("VaultOperations hides excluded paths from bulk reads", () => {
  function file(path: string): TFile {
    const f = new TFile();
    f.path = path;
    f.basename = path.split("/").pop().replace(/\.md$/, "");
    return f;
  }

  function setup() {
    const app = new App();
    const pub = file("Resources/Public plan.md");
    const priv = file("Resources/Private/Secret plan.md");
    app.vault._files = [pub, priv];
    app.vault._markdownFiles = [pub, priv];
    app.vault._cachedRead = "the master plan";
    app.metadataCache.resolvedLinks = {
      [pub.path]: { [priv.path]: 1 },
      [priv.path]: { [pub.path]: 1 },
    };
    const settings = { excludedPaths: ["Resources/Private/**"] } as LocalRestApiSettings;
    const ops = new VaultOperations(app, settings);
    return { app, ops, pub, priv, settings };
  }

  test("directory listings leave excluded folders out", async () => {
    const { ops } = setup();
    expect(await ops.listVaultDirectory("Resources")).toEqual(["Public plan.md"]);
    await expect(ops.listVaultDirectory("Resources/Private")).rejects.toThrow(ExcludedPathError);
  });

  test("simple search never returns an excluded note", async () => {
    const { ops } = setup();
    const { results, totalResults } = await ops.simpleSearch("plan");
    expect(results.map((r) => r.filename)).toEqual(["Resources/Public plan.md"]);
    expect(totalResults).toBe(1);
  });

  test("changing the list takes effect on the next search", async () => {
    const { ops, settings } = setup();
    expect((await ops.simpleSearch("secret")).results).toHaveLength(0);
    settings.excludedPaths = [];
    expect((await ops.simpleSearch("secret")).results.map((r) => r.filename)).toEqual([
      "Resources/Private/Secret plan.md",
    ]);
  });

  test("JsonLogic search never returns an excluded note", async () => {
    const { ops } = setup();
    const results = await ops.searchJsonLogic({ glob: ["**", { var: "path" }] });
    expect(results.map((r) => r.filename)).toEqual(["Resources/Public plan.md"]);
  });

  test("links and backlinks do not name excluded notes", async () => {
    const { ops, pub } = setup();
    const meta = await ops.getFileMetadataObject(pub, undefined, false);
    expect(meta.links).toEqual([]);
    expect(meta.backlinks).toEqual([]);
  });

  test("a direct read of an excluded note is refused", async () => {
    const { ops } = setup();
    await expect(ops.readFileContent("Resources/Private/Secret plan.md")).rejects.toThrow(
      ExcludedPathError,
    );
  });
});
