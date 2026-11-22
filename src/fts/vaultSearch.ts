/**
 * The vault-wide index behind simple search.
 *
 * Built on first use (or warmed at startup), then reconciled against the vault at the
 * start of every search: a file whose TFile, mtime or size changed is re-read, a file
 * that left the vault is dropped. That costs one pass over the file list -- a few
 * thousand map lookups -- and, unlike listening for events, cannot miss a change
 * made while a listener was detached or an event Obsidian never fired. The whole
 * index is rebuilt when the access policy (excluded paths, config-directory access)
 * changes, so a file the API may not read is never in it.
 */
import { TFile, getAllTags, type App } from "obsidian";
import { SearchIndex, type NameMatch, type SearchDocument, type SearchHit, type SearchOptions } from "./engine";

const MAX_BODY_CHARS = 200_000;
const META_FIELDS = ["description", "summary", "tldr"];

export interface VaultSearchPolicy {
  /** Every markdown file the API may read right now. */
  readableFiles(): TFile[];
  /** Changes whenever the answer to {@link readableFiles} may change for a reason
   *  other than the vault itself changing. */
  key(): string;
}

interface Stamp {
  file: TFile;
  mtime: number;
  size: number;
}

export class VaultSearch {
  private index = new SearchIndex();
  private stamps = new Map<string, Stamp>();
  private builtFor: string | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly policy: VaultSearchPolicy,
  ) {}

  get size(): number {
    return this.index.size;
  }

  /** Build in the background so the first search does not pay for it. */
  warm(): void {
    void this.refresh().catch((error) => console.warn("[REST API] search index build failed", error));
  }

  /** Nothing to release: the index listens to no events. Kept so the owner's
   *  dispose() reads the same whatever this class does internally. */
  detach(): void {}

  async search(query: string, options: SearchOptions = {}): Promise<{ total: number; hits: SearchHit[] }> {
    await this.refresh();
    return this.index.search(query, options);
  }

  async findByName(name: string, options: { limit?: number; similarity?: number } = {}): Promise<NameMatch[]> {
    await this.refresh();
    return this.index.findByName(name, options);
  }

  /**
   * Notes sharing the most distinctive words with a text: a lexical "more like this".
   * The coverage penalty is softened (a related note rarely has every word) and the
   * title bonus is off (the query is machine-built).
   */
  async related(
    text: string,
    { title, limit, exclude, path, tags, terms: termLimit = 12, self }:
      { title?: string; limit?: number; exclude?: string[]; path?: string; tags?: string[]; terms?: number; self?: string } = {},
  ): Promise<{ terms: string[]; total: number; hits: SearchHit[] }> {
    await this.refresh();
    const terms = this.index.distinctiveTerms(text, { title, limit: termLimit, self });
    if (terms.length === 0) return { terms, total: 0, hits: [] };
    const { total, hits } = this.index.search(terms.join(" "), {
      limit, exclude, path, tags, coveragePower: 0.5, noTitleBonus: true,
    });
    return { terms, total, hits };
  }

  /** Bring the index up to date. Concurrent callers share one pass. */
  private async refresh(): Promise<void> {
    while (this.running !== null) await this.running;
    this.running = this.reconcile().finally(() => (this.running = null));
    await this.running;
  }

  private async reconcile(): Promise<void> {
    const key = this.policy.key();
    if (key !== this.builtFor) {
      this.index.clear();
      this.stamps.clear();
      this.builtFor = key;
    }
    const files = this.policy.readableFiles().filter((file) => file.extension === "md");
    const seen = new Set<string>();
    let work = 0;
    for (const file of files) {
      seen.add(file.path);
      const stamp = this.stamps.get(file.path);
      if (stamp && stamp.file === file && stamp.mtime === file.stat.mtime && stamp.size === file.stat.size) {
        continue;
      }
      this.index.upsert(await this.toDocument(file));
      this.stamps.set(file.path, { file, mtime: file.stat.mtime, size: file.stat.size });
      // Yield now and then so a first build over a large vault does not freeze the UI.
      if (++work % 100 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    for (const path of [...this.stamps.keys()]) {
      if (seen.has(path)) continue;
      this.index.remove(path);
      this.stamps.delete(path);
    }
  }

  private async toDocument(file: TFile): Promise<SearchDocument> {
    const content = await this.app.vault.cachedRead(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    const bodyStart = cache?.frontmatterPosition?.end?.offset ?? 0;
    const meta = META_FIELDS.map((k) => fm[k])
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join("\n");
    return {
      path: file.path,
      title: file.basename,
      aliases: aliasesOf(fm),
      headings: cache?.headings?.map((h) => h.heading) ?? [],
      tags: cache ? [...new Set(getAllTags(cache) ?? [])] : [],
      meta: meta || undefined,
      body: content.slice(bodyStart, bodyStart + MAX_BODY_CHARS),
    };
  }
}

function aliasesOf(fm: Record<string, unknown>): string[] {
  const raw = fm.aliases ?? fm.alias;
  if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  return [];
}
