import { App, TFile } from "../mocks/obsidian";
import { VaultOperations } from "./vaultOperations";
import { LocalRestApiSettings } from "./types";

interface Fixture {
  path: string;
  content: string;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
  mtime?: number;
}

function setup(fixtures: Fixture[]) {
  const app = new App();
  const files = fixtures.map((f) => {
    const t = new TFile();
    t.path = f.path;
    t.basename = f.path.split("/").pop().replace(/\.md$/, "");
    t.stat = { ctime: f.mtime ?? 0, mtime: f.mtime ?? 0, size: f.content.length };
    return t;
  });
  const contents = new Map(fixtures.map((f) => [f.path, f.content]));
  const meta = new Map(fixtures.map((f) => [f.path, f]));
  app.vault._files = files;
  app.vault._markdownFiles = files;
  app.vault.read = async (f: TFile) => contents.get(f.path) ?? "";
  app.vault.cachedRead = app.vault.read;
  app.vault.modify = async (f: TFile, c: string) => {
    contents.set(f.path, c);
  };
  app.vault.getAbstractFileByPath = ((p: string) => files.find((f) => f.path === p) ?? null);
  app.metadataCache.getFileCache = ((f: TFile) => {
    const m = meta.get(f.path);
    return {
      frontmatter: m?.frontmatter,
      tags: (m?.tags ?? []).map((tag) => ({ tag })),
    };
  }) as never;
  const settings = { excludedPaths: ["Private/**"] } as LocalRestApiSettings;
  return { app, ops: new VaultOperations(app, settings), contents };
}

describe("lintVault", () => {
  test("reports each check with counts, ignoring excluded paths", async () => {
    const { app, ops } = setup([
      { path: "Thể chế hoá.md", content: "x".repeat(400), frontmatter: { description: "d" } },
      { path: "Resources/Thể chế hóa.md", content: "short" },
      { path: "a.md", content: "y".repeat(400), frontmatter: { description: "A", ai_summary: true }, tags: ["#AI"] },
      { path: "b.md", content: "z".repeat(400), tags: ["#ai"] },
      { path: "Private/p.md", content: "secret" },
    ]);
    app.metadataCache.resolvedLinks = { "a.md": { "b.md": 1 } };
    app.metadataCache.unresolvedLinks = { "a.md": { "Missing note": 1 } };
    const r = await ops.lintVault();
    expect(r.unresolvedLinks.items).toEqual([{ path: "a.md", link: "Missing note" }]);
    expect(r.orphans.items).toEqual(["Thể chế hoá.md", "Resources/Thể chế hóa.md"]);
    expect(r.stubs.items).toEqual([{ path: "Resources/Thể chế hóa.md", bytes: 5 }]);
    expect(r.missingDescription.items).toEqual(["b.md"]);
    expect(r.unreviewedAiSummaries.count).toBe(1);
    expect(r.duplicateTitles.items).toEqual([["Thể chế hoá.md", "Resources/Thể chế hóa.md"]]);
    expect(r.tagVariants.items).toEqual([{ AI: 1, ai: 1 }]);
    expect(JSON.stringify(r)).not.toContain("Private");
  });
});

describe("recentChanges", () => {
  test("lists notes changed in the window, newest first", async () => {
    const now = Date.now();
    const { ops } = setup([
      { path: "old.md", content: "Old note", mtime: now - 30 * 86_400_000 },
      { path: "new.md", content: "New note", mtime: now - 3_600_000 },
      { path: "mid.md", content: "Mid note", mtime: now - 2 * 86_400_000 },
      { path: "Private/x.md", content: "secret", mtime: now },
    ]);
    const r = await ops.recentChanges({ since: "7d" });
    expect(r.notes.map((n) => n.path)).toEqual(["new.md", "mid.md"]);
    expect(r.notes[0].description).toBe("New note");
    await expect(ops.recentChanges({ since: "yesterday-ish" })).rejects.toThrow(/since/);
  });
});

describe("updateFrontmatterMany", () => {
  const fixtures = (): Fixture[] => [
    { path: "a.md", content: "---\ntags:\n  - x\n---\nBody A\n" },
    { path: "b.md", content: "Body B\n" },
  ];

  test("a dry run reports before/after and writes nothing", async () => {
    const { ops, contents } = setup(fixtures());
    const r = await ops.updateFrontmatterMany([{ path: "a.md", set: { description: "Mô tả" } }], true);
    expect(r).toEqual([{ path: "a.md", changed: true, before: {}, after: { description: "Mô tả" } }]);
    expect(contents.get("a.md")).toBe("---\ntags:\n  - x\n---\nBody A\n");
  });

  test("applies set and unset, creating frontmatter when missing, and reports per-file errors", async () => {
    const { ops, contents } = setup(fixtures());
    const r = await ops.updateFrontmatterMany(
      [
        { path: "a.md", set: { description: "A" }, unset: ["tags"] },
        { path: "b.md", set: { description: "B", ai_summary: true } },
        { path: "missing.md", set: { description: "?" } },
        { path: "Private/p.md", set: { description: "no" } },
      ],
      false,
    );
    expect(contents.get("a.md")).toBe("---\ndescription: A\n---\nBody A\n");
    expect(contents.get("b.md")).toMatch(/^---\ndescription: B\nai_summary: true\n---\nBody B/);
    expect(r[2].error).toMatch(/not found/i);
    expect(r[3].error).toMatch(/excluded/i);
  });
});

describe("renameTag", () => {
  test("renames frontmatter and inline tags case-insensitively, nested too, skipping code", async () => {
    const { ops, contents } = setup([
      {
        path: "a.md",
        content: "---\ntags:\n  - AI\n  - ai/rag\n---\nSee #AI and #ai/rag, not `#AI` or #AIX.\n```\n#AI\n```\n",
        frontmatter: { tags: ["AI", "ai/rag"] },
        tags: ["#AI", "#ai/rag"],
      },
      { path: "b.md", content: "Nothing here", tags: [] },
    ]);
    const dry = await ops.renameTag("ai", "ml");
    expect(dry.files).toEqual([{ path: "a.md", frontmatter: 2, inline: 2 }]);
    expect(contents.get("a.md")).toContain("#AI and");
    await ops.renameTag("ai", "ml", { dryRun: false });
    expect(contents.get("a.md")).toBe(
      "---\ntags:\n  - ml\n  - ml/rag\n---\nSee #ml and #ml/rag, not `#AI` or #AIX.\n```\n#AI\n```\n",
    );
  });
});

describe("simpleSearch filters and headings", () => {
  test("path and tags narrow results; content matches carry their heading", async () => {
    const { ops } = setup([
      { path: "Resources/aws.md", content: "# AWS\n## Storage\nS3 is object storage.\n", tags: ["#aws"] },
      { path: "notes/s3.md", content: "S3 bucket notes", tags: [] },
    ]);
    const all = await ops.simpleSearch("S3");
    expect(all.results).toHaveLength(2);
    const filtered = await ops.simpleSearch("S3", { path: "resources", tags: ["aws"] });
    expect(filtered.results.map((r) => r.filename)).toEqual(["Resources/aws.md"]);
    const match = filtered.results[0].matches.find((m) => m.match.source === "content");
    expect(match?.heading).toBe("AWS > Storage");
  });
});

describe("lintVault brokenFrontmatter", () => {
  test("flags text before the opening --- and frontmatter that does not parse", async () => {
    const { app, ops } = setup([
      { path: "stray.md", content: "QUic\n---\ntags:\n  - aws\n---\nbody " + "x".repeat(300) },
      { path: "bad.md", content: "---\ntags: [unclosed\n---\nbody " + "x".repeat(300) },
      { path: "ok.md", content: "---\ntags:\n  - a\n---\nbody " + "x".repeat(300), frontmatter: { tags: ["a"] } },
    ]);
    const base = app.metadataCache.getFileCache.bind(app.metadataCache);
    app.metadataCache.getFileCache = ((f: TFile) =>
      f.path === "ok.md" ? { ...base(f), frontmatterPosition: { start: {}, end: { offset: 20 } } } : base(f)) as never;
    const r = await ops.lintVault();
    expect(r.brokenFrontmatter.items).toEqual([
      { path: "stray.md", problem: expect.stringMatching(/before the opening/) },
      { path: "bad.md", problem: expect.stringMatching(/does not parse/) },
    ]);
  });
});

describe("search log", () => {
  test("appends one JSON line per search to the plugin folder, unless turned off", async () => {
    const { app, ops } = setup([{ path: "a.md", content: "Kubernetes security notes" }]);
    const lines: Array<[string, string]> = [];
    (app.vault.adapter as unknown as { append: (p: string, d: string) => Promise<void> }).append = async (p, d) => {
      lines.push([p, d]);
    };
    await ops.simpleSearch("kubernetes", { path: "" });
    await new Promise((r) => setTimeout(r, 0));
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toBe(".obsidian/plugins/minhdq-local-rest-api/search-log.jsonl");
    const entry = JSON.parse(lines[0][1]);
    expect(entry).toMatchObject({ query: "kubernetes", total: 1, top: [{ path: "a.md" }] });

    ops.settings.logSearches = false;
    await ops.simpleSearch("kubernetes");
    await new Promise((r) => setTimeout(r, 0));
    expect(lines).toHaveLength(1);
  });
});

describe("compact search, note_find and related notes", () => {
  const fixtures = [
    { path: "Resources/Software 2.0.md", content: "Neural networks written by optimisation.", frontmatter: { description: "Karpathy's Software 2.0" } },
    { path: "Resources/Physical AI.md", content: "Robots learn in simulation: Isaac Sim, OpenUSD scenes, world models.", frontmatter: { description: "AI in robots" } },
    { path: "Projects/Robotics Infra Roadmap.md", content: "Phase 2: Isaac Lab on a 4060 Ti, SimReady USD assets." },
    { path: "Resources/Posts/HY-World 2.0.md", content: "Tencent world model: text to 3D world, export to Isaac Sim, OpenUSD, Blender." },
    { path: "Resources/Kafka.md", content: "Log-based message broker, partitions and consumer groups." },
    { path: "Private/x.md", content: "Isaac Sim secret" },
  ];

  test("compactSearch returns filename, score, description and coverage only", async () => {
    const { ops } = setup(fixtures);
    const { results } = await ops.compactSearch("software 2.0", { mode: "all" });
    expect(results).toEqual([
      { filename: "Resources/Software 2.0.md", score: expect.any(Number), description: "Karpathy's Software 2.0", coverage: 1 },
    ]);
  });

  test("findNotes reports no match for a new name and an exact one for an existing name", async () => {
    const { ops } = setup(fixtures);
    const [none, hy, sw] = await ops.findNotes(["SimReady Central", "HY World 3.0", "software 2.0"]);
    expect(none.matches).toEqual([]);
    expect(hy.matches).toEqual([expect.objectContaining({ path: "Resources/Posts/HY-World 2.0.md", kind: "similar" })]);
    expect(sw.matches).toEqual([
      expect.objectContaining({ path: "Resources/Software 2.0.md", kind: "exact", via: "title", description: "Karpathy's Software 2.0" }),
    ]);
  });

  test("relatedNotes finds notes sharing distinctive words, marks existing links, hides excluded paths", async () => {
    const { app, ops } = setup(fixtures);
    app.metadataCache.resolvedLinks = { "Resources/Posts/HY-World 2.0.md": { "Resources/Physical AI.md": 1 } };
    const r = await ops.relatedNotes({ path: "Resources/Posts/HY-World 2.0.md" });
    expect(r.terms).toEqual(expect.arrayContaining(["isaac", "openusd"]));
    const names = r.results.map((x) => x.filename);
    expect(names.slice(0, 2).sort()).toEqual(["Projects/Robotics Infra Roadmap.md", "Resources/Physical AI.md"]);
    expect(names).not.toContain("Resources/Posts/HY-World 2.0.md");
    expect(names).not.toContain("Private/x.md");
    expect(r.results.find((x) => x.filename === "Resources/Physical AI.md")?.linked).toBe("out");
    await expect(ops.relatedNotes({})).rejects.toThrow(/path.*text/);
  });
});

describe("lintVault on a single note", () => {
  test("checks only that note but judges duplicate names and tag variants against the vault", async () => {
    const { ops } = setup([
      { path: "new.md", content: "x".repeat(400), tags: ["#AI"] },
      { path: "Resources/New.md", content: "y".repeat(400), frontmatter: { description: "d" }, tags: ["#ai"] },
      { path: "other.md", content: "short", tags: ["#Foo"] },
      { path: "other2.md", content: "short", tags: ["#foo"] },
    ]);
    const r = await ops.lintVault({ path: "new.md" });
    expect(r.missingDescription.items).toEqual(["new.md"]);
    expect(r.stubs.count).toBe(0);
    expect(r.duplicateTitles.items).toEqual([["new.md", "Resources/New.md"]]);
    expect(r.tagVariants.items).toEqual([{ AI: 1, ai: 1 }]);
  });
});
