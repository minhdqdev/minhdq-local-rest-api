import { App, TFile } from "../mocks/obsidian";
import { VaultOperations } from "./vaultOperations";
import { LocalRestApiSettings } from "./types";
import { ExcludedPathError } from "./vaultPath";

function note(path: string, content: string, frontmatter?: Record<string, unknown>) {
  const f = new TFile();
  f.path = path;
  f.basename = path.split("/").pop().replace(/\.md$/, "");
  (f as unknown as { name: string }).name = path.split("/").pop()!;
  return { file: f, content, frontmatter };
}

function setup(notes: ReturnType<typeof note>[], extra: TFile[] = []) {
  const app = new App();
  const files = notes.map((n) => n.file);
  app.vault._files = [...files, ...extra];
  app.vault._markdownFiles = files;
  const byPath = new Map(notes.map((n) => [n.file.path, n]));
  app.vault.cachedRead = async (f: TFile) => byPath.get(f.path)?.content ?? "";
  app.vault.getAbstractFileByPath = ((p: string) => byPath.get(p)?.file ?? null);
  app.metadataCache.getFileCache = ((f: TFile) =>
    ({ frontmatter: byPath.get(f.path)?.frontmatter })) as never;
  const settings = { excludedPaths: ["Private/**"] } as LocalRestApiSettings;
  return { app, ops: new VaultOperations(app, settings) };
}

describe("noteDescription", () => {
  test("prefers frontmatter description, then summary", async () => {
    const { ops } = setup([]);
    const a = note("a.md", "body", { description: "From frontmatter" });
    const b = note("b.md", "body", { summary: "A summary" });
    const { ops: o2 } = setup([a, b]);
    expect(await o2.noteDescription(a.file as never)).toBe("From frontmatter");
    expect(await o2.noteDescription(b.file as never)).toBe("A summary");
    void ops;
  });

  test("falls back to the first line of prose, skipping headings, callout headers and code", async () => {
    const n = note(
      "n.md",
      "---\ntags: [x]\n---\n## Introduction\n> [!tldr]+ TL;DR\n> - Think **MCP** like [[USB-C|USB C]] for AI apps\n",
    );
    const { ops } = setup([n]);
    expect(await ops.noteDescription(n.file as never)).toBe("Think MCP like USB C for AI apps");
  });

  test("clips long lines", async () => {
    const n = note("n.md", "x".repeat(500));
    const { ops } = setup([n]);
    const d = await ops.noteDescription(n.file, 50);
    expect([...d]).toHaveLength(50);
    expect(d.endsWith("…")).toBe(true);
  });
});

describe("vaultTree", () => {
  const notes = [
    note("Resources/AWS/EC2.md", "Virtual servers."),
    note("Resources/Bun.md", "A fast JS runtime."),
    note("Private/id.md", "secret"),
    note("Top.md", "", { description: "Root note" }),
  ];
  const image = new TFile();
  Object.assign(image, { path: "Resources/img.png", extension: "png", basename: "img" });

  test("outlines folders with counts and notes with descriptions, hiding excluded paths", async () => {
    const { ops } = setup(notes, [image]);
    const { tree, omitted } = await ops.vaultTree("", { depth: 3 });
    expect(tree).toBe(
      [
        "/ (3 notes, 1 other files)",
        "  Resources/ (2 notes, 1 other files)",
        "    AWS/ (1 notes)",
        "      EC2.md — Virtual servers.",
        "    Bun.md — A fast JS runtime.",
        "  Top.md — Root note",
      ].join("\n"),
    );
    expect(omitted).toBe(0);
  });

  test("depth 1 lists only the first level", async () => {
    const { ops } = setup(notes);
    const { tree } = await ops.vaultTree("", { depth: 1 });
    expect(tree.split("\n")).toEqual(["/ (3 notes)", "  Resources/ (2 notes)", "  Top.md — Root note"]);
  });

  test("maxEntries truncates and counts what was left out", async () => {
    const { ops } = setup(notes);
    const { tree, omitted } = await ops.vaultTree("", { depth: 3, maxEntries: 2 });
    expect(tree.split("\n")).toHaveLength(2);
    expect(omitted).toBeGreaterThan(0);
  });

  test("an excluded folder is refused", async () => {
    const { ops } = setup(notes);
    await expect(ops.vaultTree("Private")).rejects.toThrow(ExcludedPathError);
  });
});

describe("noteNeighbors", () => {
  test("lists links and backlinks with descriptions, two hops on request, never excluded notes", async () => {
    const a = note("a.md", "Note A");
    const b = note("b.md", "Note B");
    const c = note("c.md", "Note C");
    const p = note("Private/p.md", "secret");
    const { app, ops } = setup([a, b, c, p]);
    app.metadataCache.resolvedLinks = {
      "a.md": { "b.md": 1, "Private/p.md": 1 },
      "c.md": { "b.md": 1 },
      "Private/p.md": { "a.md": 1 },
    };
    const one = await ops.noteNeighbors("a.md");
    expect(one.links).toEqual([{ path: "b.md", description: "Note B" }]);
    expect(one.backlinks).toEqual([]);
    const two = await ops.noteNeighbors("a.md", { depth: 2 });
    expect(two.secondHop).toEqual([{ path: "c.md", via: "b.md", description: "Note C" }]);
  });
});
