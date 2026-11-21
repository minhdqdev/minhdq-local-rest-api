import {
  getAllTags,
  App,
  CachedMetadata,
  Command,
  Component,
  MarkdownRenderer,
  TFile,
} from "obsidian";
import { VaultSearch } from "./fts/vaultSearch";
import { findMatches } from "./fts/matches";
import { foldText } from "./fts/text";
import { parse as parseYaml } from "yaml";
import { LOCAL_REST_API_PLUGIN_ID } from "./publicApi";
import path from "path";
import {
  applyPatch,
  getDocumentMap,
  PatchInstruction,
  PatchOperation,
  PatchTargetType,
} from "markdown-patch";
import {
  patch as patchV2,
  projectMap,
  buildModel,
  readTarget,
  versionOf,
} from "markdown-patch-2";
import type {
  InstructionInput,
  PatchResult,
  PublicMap,
  ReadTarget,
  ReadResult,
} from "markdown-patch-2";
import jsonLogic from "json-logic-js";
import WildcardRegexp from "glob-to-regexp";

export class FileNotFoundError extends Error {}
export class CommandNotFoundError extends Error {}
export class DestinationAlreadyExistsError extends Error {}

import {
  DocumentMapObject,
  FileMetadataObject,
  LocalRestApiSettings,
  SearchContext,
  SearchJsonResponseItem,
  SearchResponseItem,
  SimpleSearchOptions,
  SimpleSearchResult,
} from "./types";
import { toArrayBuffer } from "./utils";
import {
  CurrentFileState,
  hasPreconditions,
  PreconditionFailedError,
  preconditionFailure,
  WritePreconditions,
} from "./conditionalRequests";
import {
  assertVaultPathIsContained,
  assertConfigDirAccessAllowed,
  assertNotExcluded,
  configDirMatcher,
  excludedPathMatcher,
  onDiskAccessFor,
  ConfigDirAccessError,
  PathTraversalError,
  type LinkMemo,
} from "./vaultPath";

/**
 * Every event Obsidian's metadata cache publicly declares, and every event its
 * vault publicly declares.
 *
 * Deliberately the whole surface rather than the subset that looks like it moves
 * the link graph. `resolvedLinks` is Obsidian's own derived state, and which of
 * its events happen to precede an update to it is an implementation detail of a
 * dependency -- betting a cache's correctness on having read that detail right
 * is a bet nobody can win permanently. Subscribing to everything removes the
 * judgement call, and costs only a rebuild the uncached code performed on every
 * single read anyway.
 *
 * `src/vaultOperations.test.ts` reads these names back out of the installed
 * obsidian typings and fails if the two ever disagree, so an Obsidian upgrade
 * that adds an event is a red test rather than a cache that quietly goes stale.
 */
export const METADATA_CACHE_EVENTS = [
  "changed",
  "deleted",
  "resolve",
  "resolved",
] as const;
export const VAULT_EVENTS = ["create", "modify", "delete", "rename"] as const;

/**
 * How long a built backlinks index may be served before it is rebuilt anyway.
 *
 * The listeners above cover everything Obsidian announces, but "everything it
 * announces" is not the same as "everything that happens": an event added in a
 * future release, or an internal path that rewrites `resolvedLinks` without
 * saying so, would otherwise leave a stale index in place for as long as the
 * plugin runs. Ageing the index out turns that unbounded failure into a bounded
 * one, without depending on any part of Obsidian's API being what we think.
 */
export const BACKLINKS_INDEX_MAX_AGE_MS = 60_000;

/**
 * Writes go through Vault.modify/Vault.create rather than Vault.adapter.write.
 *
 * The adapter writes straight to disk, behind Obsidian's back: the change is only
 * noticed later, by the file watcher. Until it is, metadataCache still describes the
 * previous revision, and because getFileMetadataObject serves frontmatter and tags
 * from that cache, a client that wrote and immediately read back could be handed
 * pre-write metadata. Going through the Vault API keeps Obsidian's own bookkeeping in
 * step with the write instead of racing it.
 */
export class VaultOperations {
  private cachedBacklinksIndex: Record<string, string[]> | null = null;
  private cachedBacklinksIndexBuiltAt = 0;

  /**
   * The tail of each path's queue of in-flight writes: a promise that settles
   * when the most recently queued write on that path finishes. See
   * {@link withPathLocks}.
   */
  private readonly pathLocks = new Map<string, Promise<void>>();

  /**
   * Called whenever Obsidian says anything at all has happened.
   *
   * Deliberately one handler for every announcement rather than a targeted
   * update per event: rebuilding is the same work the uncached code did on
   * every request, so an invalidation too many costs a scan we were paying for
   * anyway, while one too few serves a client stale backlinks.
   */
  private readonly invalidateBacklinksIndex = (): void => {
    this.cachedBacklinksIndex = null;
  };

  /** The ranked, Vietnamese-aware full-text index behind {@link simpleSearch}. */
  private readonly vaultSearch: VaultSearch;

  constructor(readonly app: App, readonly settings: LocalRestApiSettings) {
    this.vaultSearch = new VaultSearch(app, {
      readableFiles: () => this.readableMarkdownFiles(),
      key: () =>
        JSON.stringify([this.settings.excludedPaths ?? [], this.settings.enableConfigDirAccess ?? false]),
    });
    // Warm the index once Obsidian has finished indexing the vault itself, so the
    // first search does not pay for the build.
    this.app.workspace?.onLayoutReady?.(() => this.vaultSearch.warm());
    for (const event of METADATA_CACHE_EVENTS) {
      this.app.metadataCache.on(
        event as "resolved",
        this.invalidateBacklinksIndex,
      );
    }
    for (const event of VAULT_EVENTS) {
      this.app.vault.on(event as "modify", this.invalidateBacklinksIndex);
    }

    jsonLogic.add_operation(
      "glob",
      (pattern: string | undefined, field: string | undefined) => {
        if (typeof field === "string" && typeof pattern === "string") {
          return WildcardRegexp(pattern).test(field);
        }
        return false;
      },
    );
    jsonLogic.add_operation(
      "regexp",
      (pattern: string | undefined, field: string | undefined) => {
        if (typeof field === "string" && typeof pattern === "string") {
          return new RegExp(pattern).test(field);
        }
        return false;
      },
    );
  }

  /**
   * Releases the link-graph listeners registered in the constructor.
   *
   * This object lives as long as the plugin does, so this matters only at
   * unload -- but a listener left behind holds the whole instance alive and
   * goes on invalidating a cache nobody will read again.
   */
  dispose(): void {
    this.vaultSearch.detach();
    for (const event of METADATA_CACHE_EVENTS) {
      this.app.metadataCache.off(event, this.invalidateBacklinksIndex);
    }
    for (const event of VAULT_EVENTS) {
      this.app.vault.off(event, this.invalidateBacklinksIndex);
    }
  }

  /** Refuse a client-supplied path this API is not allowed to touch.
   *
   *  Every caller -- the REST handler, the MCP tools, a plugin holding the
   *  extension API -- funnels through this class, so the authorization decision
   *  lives here as well as at each boundary. The boundaries exist to give a
   *  caller a well-shaped error (a 400/403 with an errorCode, a legible MCP tool
   *  error); this exists so that a boundary someone forgets to guard cannot reach
   *  the filesystem. Two rules apply:
   *
   *  - The path must stay inside the vault root (see ./vaultPath for why
   *    Obsidian's own API does not enforce this).
   *  - The path must not be inside Obsidian's configuration directory unless the
   *    operator has turned that on. Writing there is code execution (Obsidian
   *    evals an enabled plugin's main.js) and reading there leaks secrets such as
   *    this plugin's own API key; see GHSA-66m9-r757-qvq7. */
  private assertContained(filePath: string, label = "Path"): void {
    assertVaultPathIsContained(filePath, label);
    assertConfigDirAccessAllowed(
      filePath,
      this.app.vault.configDir,
      this.settings.enableConfigDirAccess ?? false,
      label,
      onDiskAccessFor(this.app.vault.adapter),
    );
    assertNotExcluded(filePath, this.settings.excludedPaths, label);
  }

  /** Whether the operator has excluded `filePath` from the API (see
   *  `LocalRestApiSettings.excludedPaths`). Used by everything that enumerates
   *  paths -- listings, searches, links, events -- to leave such files out. */
  isPathExcluded(filePath: string): boolean {
    return excludedPathMatcher(this.settings.excludedPaths)(filePath);
  }

  /** The indexed markdown files a bulk read -- a search, the tag census -- may
   *  touch: everything Obsidian indexes, minus whatever lives in the
   *  configuration directory. Obsidian never indexes a dot-directory itself, so
   *  a config-dir file only gets here through a symlink the owner planted in the
   *  vault; a direct read of that path is refused, and a search handing its
   *  contents out instead would be the same disclosure by another route. The
   *  matcher is built once per call so the whole index costs one on-disk lookup
   *  per directory, not per file. */
  private readableMarkdownFiles(): TFile[] {
    const excluded = excludedPathMatcher(this.settings.excludedPaths);
    const files = this.app.vault.getMarkdownFiles().filter((file) => !excluded(file.path));
    if (this.settings.enableConfigDirAccess) return files;
    const inConfigDir = configDirMatcher(
      this.app.vault.configDir,
      onDiskAccessFor(this.app.vault.adapter),
      this.linkMemo,
    );
    const readable = files.filter(
      (file) => !inConfigDir(file.path, `${file.stat.ctime}:${file.stat.mtime}:${file.stat.size}`),
    );
    // Forget files that have left the index, so the memo tracks the vault's
    // size rather than its history.
    if (this.linkMemo.size > files.length * 2) {
      const current = new Set(files.map((file) => file.path));
      for (const key of this.linkMemo.keys()) {
        if (!current.has(key)) this.linkMemo.delete(key);
      }
    }
    return readable;
  }

  /** What {@link readableMarkdownFiles} remembers between searches: whether each
   *  indexed file is a symlink, keyed by the file's literal path and valid while
   *  its indexed ctime/mtime/size are unchanged. See {@link configDirMatcher}. */
  private readonly linkMemo: LinkMemo = new Map();

  /** The gate for an operation that creates or removes an *entry* -- a move,
   *  a copy, a delete -- rather than reading or writing a file's contents.
   *
   *  {@link assertContained} follows a symlink to its target, which is right
   *  for a read or a content write: those act on the target. But an entry is
   *  created or removed in its *parent*, and a symlink the owner planted inside
   *  the config dir that points back into the vault passes the target check
   *  while living somewhere this API may not touch: removing it removes a
   *  config-dir entry, and an overwrite would then create a real file at that
   *  spelling inside the config dir. So the parent is checked too, before
   *  anything is removed. */
  private assertEntryContained(filePath: string, label = "Path"): void {
    this.assertContained(filePath, label);
    const parent = path.posix.dirname(filePath);
    this.assertContained(parent === "." ? "" : parent, label);
  }

  /** Stat a path straight from the adapter, through the authorization gate.
   *
   *  The REST whole-file GET handler needs a raw stat to tell a file from a
   *  directory from a miss, and historically called `adapter.stat` directly --
   *  the one filesystem access that bypassed this class. Routing it here keeps
   *  this class the single place a path is authorized before it reaches disk. */
  async statPath(
    filePath: string,
  ): Promise<ReturnType<typeof this.app.vault.adapter.stat>> {
    this.assertContained(filePath);
    return this.app.vault.adapter.stat(filePath);
  }

  /** Read a path's raw bytes straight from the adapter, through the gate.
   *
   *  Unlike {@link readBinaryFileContent}, this does not require the path to be an
   *  indexed vault file: the REST GET handler has already confirmed it exists via
   *  {@link statPath} and may be serving a target-addressed path. It exists so that
   *  read, too, funnels through this class rather than touching the adapter
   *  directly. */
  async readBinaryPath(filePath: string): Promise<ArrayBuffer> {
    this.assertContained(filePath);
    return this.app.vault.adapter.readBinary(filePath);
  }

  private waitForFileCache(
    file: TFile,
    timeoutMs = 5000,
  ): Promise<CachedMetadata | null> {
    const existingCache = this.app.metadataCache.getFileCache(file);
    if (existingCache) {
      return Promise.resolve(existingCache);
    }

    return new Promise((resolve) => {
      let resolved = false;

      const onCacheChange = (...data: unknown[]) => {
        const changedFile = data[0];
        if (!(changedFile instanceof TFile)) return;
        if (changedFile.path === file.path && !resolved) {
          resolved = true;
          this.app.metadataCache.off("changed", onCacheChange);
          window.clearTimeout(timeoutId);
          resolve(this.app.metadataCache.getFileCache(file));
        }
      };

      const timeoutId = window.setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.app.metadataCache.off("changed", onCacheChange);
          console.warn(
            `[REST API] Timeout waiting for metadata cache for ${file.path} after ${timeoutMs}ms`,
          );
          resolve(this.app.metadataCache.getFileCache(file));
        }
      }, timeoutMs);

      this.app.metadataCache.on("changed", onCacheChange);

      const cacheAfterListener = this.app.metadataCache.getFileCache(file);
      if (cacheAfterListener && !resolved) {
        resolved = true;
        this.app.metadataCache.off("changed", onCacheChange);
        window.clearTimeout(timeoutId);
        resolve(cacheAfterListener);
      }
    });
  }

  async getDocumentMapObject(file: TFile): Promise<DocumentMapObject> {
    const content = await this.app.vault.adapter.read(file.path);
    const documentMap = getDocumentMap(content);

    return {
      headings: Object.keys(documentMap.heading)
        .filter((h) => h)
        .map((h) => h.split("\x1f").join("::")),
      blocks: Object.keys(documentMap.block),
      frontmatterFields: Object.keys(documentMap.frontmatter),
    };
  }

  /**
   * The markdown-patch 2.0 document map: headings nested by containment (each
   * heading text maps to its child headings; every occurrence of a repeated
   * sibling gets its own key, later ones carrying a reserved marker suffix),
   * block ids disambiguated the same way, frontmatter field names, and the
   * content-hash `version` token clients pass back as a patch `ifMatch`
   * precondition.
   */
  async getDocumentMapV2Object(file: TFile): Promise<PublicMap> {
    const content = await this.app.vault.adapter.read(file.path);
    return projectMap(buildModel(content));
  }

  /**
   * The markdown-patch 2.0 targeted read: resolve a `(targetType, target)`
   * address — a heading path array, a bare block id, or a frontmatter key — and
   * return the section body (headings/blocks) or parsed value (frontmatter).
   * Throws {@link TargetNotFoundError} when the address does not resolve.
   *
   * `content` lets a caller that has already read the file supply what it read,
   * rather than paying for a second read — MCP's `vault_read` decodes the raw
   * bytes itself so it can refuse a file that is not valid UTF-8, and passes the
   * result through here.
   */
  async readFileSectionMdp2(
    file: TFile,
    target: ReadTarget,
    content?: string,
  ): Promise<ReadResult> {
    const text = content ?? (await this.app.vault.adapter.read(file.path));
    return readTarget(text, target);
  }

  async readFileSection(
    file: TFile,
    targetType: string,
    target: string,
    targetDelimiter = "::",
  ): Promise<unknown> {
    const content = await this.app.vault.adapter.read(file.path);
    const documentMap = getDocumentMap(content);

    if (targetType === "frontmatter") {
      const value: unknown = documentMap.frontmatter[target];
      if (value === undefined)
        throw new Error(`Frontmatter key not found: ${target}`);
      return value;
    }

    const mapKey =
      targetType === "heading"
        ? target.split(targetDelimiter).join("\x1f")
        : target;

    const entry =
      targetType === "heading"
        ? documentMap.heading[mapKey]
        : documentMap.block[mapKey];

    if (!entry) throw new Error(`${targetType} not found: ${target}`);

    return content.substring(entry.content.start, entry.content.end);
  }

  /**
   * The vault-wide "who links here" index, built at most once per link-graph
   * change and, failing that, at most once per BACKLINKS_INDEX_MAX_AGE_MS.
   *
   * The age check is the half that does not trust Obsidian: the listeners drop
   * the index the moment anything is announced, and the ceiling makes sure an
   * announcement that never comes cannot keep a wrong answer in circulation.
   *
   * Callers doing bulk work should build one snapshot with this and thread it
   * through their loop (see `getFileMetadataObject`'s second argument), so that
   * every row of a result set describes the same moment even if the graph moves
   * mid-loop.
   */
  getBacklinksIndex(): Record<string, string[]> {
    const now = Date.now();
    if (
      this.cachedBacklinksIndex === null ||
      now - this.cachedBacklinksIndexBuiltAt >= BACKLINKS_INDEX_MAX_AGE_MS
    ) {
      this.cachedBacklinksIndex = this.buildBacklinksIndex();
      this.cachedBacklinksIndexBuiltAt = now;
    }
    return this.cachedBacklinksIndex;
  }

  buildBacklinksIndex(): Record<string, string[]> {
    const index: Record<string, string[]> = {};
    const excluded = excludedPathMatcher(this.settings.excludedPaths);
    for (const [sourcePath, targets] of Object.entries(
      this.app.metadataCache.resolvedLinks,
    )) {
      if (excluded(sourcePath)) continue;
      for (const targetPath of Object.keys(targets)) {
        if (excluded(targetPath)) continue;
        (index[targetPath] ??= []).push(sourcePath);
      }
    }
    return index;
  }

  /**
   * `content`, like {@link readFileSectionMdp2}'s, is content the caller has
   * already read: supplying it skips the `cachedRead` below. Ignored when
   * `includeContent` is false, since then nothing is read at all.
   */
  async getFileMetadataObject(
    file: TFile,
    backlinksIndex?: Record<string, string[]>,
    includeContent = true,
    content?: string,
  ): Promise<FileMetadataObject> {
    // A TFile came from the index, which only ever says the file exists -- not
    // that this API may read it. Gated here so a caller handing over a TFile it
    // found by other means is held to the same rule as one naming a path.
    this.assertContained(file.path);
    const metadata = await this.metadataObjectFor(file, backlinksIndex, includeContent, content);
    // Hashed from the text being returned, so the token always describes the
    // content beside it. For a valid UTF-8 file -- every note -- that is the same
    // value as the hash of its bytes that conditional writes check against.
    return includeContent ? { ...metadata, version: versionOf(metadata.content) } : metadata;
  }

  /** {@link getFileMetadataObject} without the gate, for {@link searchJsonLogic},
   *  which has already authorized every file it iterates in one pass. */
  private async metadataObjectFor(
    file: TFile,
    backlinksIndex?: Record<string, string[]>,
    includeContent = true,
    content?: string,
  ): Promise<FileMetadataObject> {
    const cache = await this.waitForFileCache(file);

    const frontmatter = { ...(cache?.frontmatter ?? {}) };
    delete frontmatter.position;

    const directTags = (cache?.tags ?? [])
      .filter((tag) => tag)
      .map((tag) => tag.tag);
    const frontmatterTags = Array.isArray(frontmatter.tags)
      ? (frontmatter.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const filteredTags: string[] = [...frontmatterTags, ...directTags]
      .filter((tag) => tag)
      .map((tag) => tag.replace(/^#/, ""))
      .filter((value, index, self) => self.indexOf(value) === index);

    const links = Object.keys(
      this.app.metadataCache.resolvedLinks[file.path] ?? {},
    ).filter((target) => !this.isPathExcluded(target));
    const unresolvedLinks = Object.keys(
      this.app.metadataCache.unresolvedLinks[file.path] ?? {},
    );

    const index = backlinksIndex ?? this.getBacklinksIndex();
    // Copied rather than handed out: the cached index outlives the response
    // built from it, so one caller mutating what it was given would otherwise
    // reach every caller after it.
    const backlinks = (index[file.path] ?? []).filter((source) => !this.isPathExcluded(source));

    return {
      tags: filteredTags,
      frontmatter: frontmatter,
      stat: file.stat,
      path: file.path,
      content: includeContent
        ? (content ?? (await this.app.vault.cachedRead(file)))
        : "",
      links,
      backlinks,
      unresolvedLinks,
    };
  }

  async renderFileToHtml(file: TFile, content?: string): Promise<string> {
    this.assertContained(file.path);
    const markdown = content ?? (await this.app.vault.cachedRead(file));
    const el = activeDocument.createElement("div");
    const component = new Component();
    component.load();
    try {
      await MarkdownRenderer.render(this.app, markdown, el, file.path, component);
      return el.innerHTML;
    } finally {
      component.unload();
    }
  }

  async resolvePathAndTarget(rawSegments: string[]): Promise<{
    filePath: string;
    targetType?: string;
    target?: string;
    // For a heading target, the raw path segments as an array (e.g. ["A", "B"]
    // for `.../heading/A/B`). Preserved alongside the `::`-joined `target` so the
    // 2.0 engine can address headings array-natively without a delimiter split
    // that a heading containing `::` would break.
    targetSegments?: string[];
  } | null> {
    // Segments arrive already split on the URL's *raw* slashes and decoded one
    // by one, so a `%2F` inside a segment is a literal `/` belonging to that
    // segment (a heading name), not a path boundary. Drop a trailing empty
    // segment left by a trailing slash.
    const segments =
      rawSegments.length > 0 && rawSegments[rawSegments.length - 1] === ""
        ? rawSegments.slice(0, -1)
        : rawSegments;
    if (segments.length === 0) return null;

    // The joined address is checked first so an escaping or refused address is
    // a no-match before anything is statted. That check does *not* cover the
    // prefixes the walk below stats: "notes/cfg/README.md/comments/../../../safe"
    // resolves to "notes/safe" and passes, while the walk would stat
    // "notes/cfg/README.md" -- a protected file if "cfg" is a symlink into the
    // config dir. So every stat goes through the gate (statPath), and a refused
    // candidate is a miss. A refusal is a no-match, not an error: both callers
    // (the REST GET and the sub-resource dispatcher) read null as "not a file
    // here", and the REST boundary has already sent its own 403 for anything
    // the joined check would refuse. Only a refusal is a miss, though: anything
    // else thrown while deciding is a fault, and swallowing it would hide it
    // behind a 404.
    try {
      this.assertContained(segments.join("/"));
    } catch (error) {
      if (error instanceof PathTraversalError || error instanceof ConfigDirAccessError) {
        return null;
      }
      throw error;
    }

    // A file or folder name cannot contain `/`, so a candidate file path is only
    // valid when none of its segments do. This is what keeps a decoded `%2F`
    // from re-forming a path separator: `folder%2Fnote.md` is a single segment
    // "folder/note.md", which can never be a file component and so never
    // resolves as one.
    const isFilePath = (parts: string[]): boolean =>
      parts.every((part) => !part.includes("/"));

    if (isFilePath(segments)) {
      let exactStat = null;
      try {
        exactStat = await this.statPath(segments.join("/"));
      } catch {
        // ENOTDIR: a path component is a file, not a directory;
        // fall through to the backward walk which will find the actual file.
      }
      if (exactStat?.type === "file") {
        return { filePath: segments.join("/") };
      }
    }

    for (let i = segments.length - 1; i >= 1; i--) {
      const prefix = segments.slice(0, i);
      if (!isFilePath(prefix)) continue;
      const candidate = prefix.join("/");
      let s = null;
      try {
        s = await this.statPath(candidate);
      } catch {
        // ENOTDIR, or a candidate the gate refused: either way not a file here.
        continue;
      }
      if (s?.type === "file") {
        const remainder = segments.slice(i);
        const targetType = remainder[0];
        const targetSegments =
          targetType === "heading" ? remainder.slice(1) : undefined;
        const target =
          targetType === "heading"
            ? remainder.slice(1).join("::")
            : remainder[1];
        return { filePath: candidate, targetType, target, targetSegments };
      }
    }

    return null;
  }

  /** A note's one-line summary for navigation: its frontmatter `description`,
   *  `summary` or `tldr` when it has one, otherwise the first line of prose in its
   *  body (headings, callout markers, list bullets and links stripped), cut to
   *  `maxChars`. Empty when the note has neither. */
  async noteDescription(file: TFile, maxChars = 140): Promise<string> {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    for (const key of ["description", "summary", "tldr"]) {
      const value = fm[key];
      if (typeof value === "string" && value.trim()) return clip(value.trim(), maxChars);
    }
    const content = await this.app.vault.cachedRead(file);
    const bodyStart = cache?.frontmatterPosition?.end?.offset ?? frontmatterEnd(content);
    let inCode = false;
    for (const raw of content.slice(bodyStart, bodyStart + 20_000).split("\n")) {
      const line = raw.trim();
      if (line.startsWith("```")) {
        inCode = !inCode;
        continue;
      }
      if (inCode || !line || line === "---" || /^#{1,6}\s/.test(line)) continue;
      if (/^>\s*\[!/.test(line)) continue; // a callout header: its title is a label, not prose
      const text = line
        .replace(/^>\s*(\[![^\]]*\][+-]?\s*)?/, "")
        .replace(/^([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, "")
        .replace(/!?\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_m, target: string, _a, alias?: string) => alias ?? target)
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]+/g, "")
        .trim();
      if (text.length >= 3) return clip(text, maxChars);
    }
    return "";
  }

  /** A depth-limited outline of a vault folder for an agent to navigate before it
   *  reads anything: sub-folders with how many notes (and other files) they hold,
   *  then notes with their one-line {@link noteDescription}. Excluded paths and the
   *  configuration directory are left out, as everywhere else. Stops after
   *  `maxEntries` lines and says how many were left out. */
  async vaultTree(
    dirPath: string,
    { depth = 2, maxEntries = 300, descriptions = true }: { depth?: number; maxEntries?: number; descriptions?: boolean } = {},
  ): Promise<{ tree: string; entries: number; omitted: number }> {
    this.assertContained(dirPath, "Directory path");
    const root = dirPath.replace(/^\/+|\/+$/g, "");
    const prefix = root ? `${root}/` : "";
    const readable = new Set(this.readableMarkdownFiles().map((f) => f.path));
    const excluded = excludedPathMatcher(this.settings.excludedPaths);
    const configDir = this.app.vault.configDir;

    interface Folder {
      folders: Map<string, Folder>;
      notes: TFile[];
      noteCount: number;
      otherCount: number;
    }
    const make = (): Folder => ({ folders: new Map(), notes: [], noteCount: 0, otherCount: 0 });
    const top = make();
    for (const file of this.app.vault.getFiles()) {
      if (!file.path.startsWith(prefix) || excluded(file.path)) continue;
      if (file.path === configDir || file.path.startsWith(`${configDir}/`)) continue;
      const isNote = file.extension === "md";
      if (isNote && !readable.has(file.path)) continue;
      const parts = file.path.slice(prefix.length).split("/");
      let node = top;
      for (const part of parts.slice(0, -1)) {
        if (isNote) node.noteCount++;
        else node.otherCount++;
        let child = node.folders.get(part);
        if (!child) node.folders.set(part, (child = make()));
        node = child;
      }
      if (isNote) {
        node.noteCount++;
        node.notes.push(file);
      } else node.otherCount++;
    }

    const lines: string[] = [];
    let omitted = 0;
    const header = `${root ? `${root}/` : "/"} (${top.noteCount} notes${top.otherCount ? `, ${top.otherCount} other files` : ""})`;
    lines.push(header);
    const walk = async (node: Folder, level: number, indent: string): Promise<void> => {
      const folders = [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b));
      for (const [name, child] of folders) {
        if (lines.length >= maxEntries) {
          omitted += 1;
          continue;
        }
        const counts = `${child.noteCount} notes${child.otherCount ? `, ${child.otherCount} other files` : ""}`;
        lines.push(`${indent}${name}/ (${counts})`);
        if (level + 1 < depth) await walk(child, level + 1, indent + "  ");
      }
      const notes = [...node.notes].sort((a, b) => a.basename.localeCompare(b.basename));
      for (const note of notes) {
        if (lines.length >= maxEntries) {
          omitted += 1;
          continue;
        }
        const description = descriptions ? await this.noteDescription(note) : "";
        lines.push(`${indent}${note.name}${description ? ` — ${description}` : ""}`);
      }
    };
    await walk(top, 0, "  ");
    return { tree: lines.join("\n"), entries: lines.length - 1, omitted };
  }

  /** The notes around one note in the link graph: what it links to and what links
   *  to it, each with its one-line description, out to `depth` hops (1 or 2).
   *  Excluded notes never appear, even as a stepping stone to a second hop. */
  async noteNeighbors(
    filePath: string,
    { depth = 1, limit = 50 }: { depth?: number; limit?: number } = {},
  ): Promise<{
    path: string;
    links: Array<{ path: string; description: string }>;
    backlinks: Array<{ path: string; description: string }>;
    secondHop?: Array<{ path: string; via: string; description: string }>;
    omitted: number;
  }> {
    this.assertContained(filePath);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new FileNotFoundError(`File not found: ${filePath}`);
    const readable = new Map(this.readableMarkdownFiles().map((f) => [f.path, f]));
    const backlinksIndex = this.getBacklinksIndex();
    const outOf = (p: string) =>
      Object.keys(this.app.metadataCache.resolvedLinks[p] ?? {}).filter((t) => t !== p && readable.has(t));
    const into = (p: string) => (backlinksIndex[p] ?? []).filter((s) => s !== p && readable.has(s));

    let budget = Math.max(1, limit);
    let omitted = 0;
    const describe = async (p: string) => {
      const f = readable.get(p);
      return f ? this.noteDescription(f) : "";
    };
    const take = async (paths: string[]) => {
      const out: Array<{ path: string; description: string }> = [];
      for (const p of [...new Set(paths)].sort()) {
        if (budget <= 0) {
          omitted++;
          continue;
        }
        budget--;
        out.push({ path: p, description: await describe(p) });
      }
      return out;
    };
    const links = await take(outOf(filePath));
    const backlinks = await take(into(filePath));
    const result: Awaited<ReturnType<VaultOperations["noteNeighbors"]>> = { path: filePath, links, backlinks, omitted: 0 };
    if (depth >= 2) {
      const first = new Set([filePath, ...links.map((l) => l.path), ...backlinks.map((b) => b.path)]);
      const second = new Map<string, string>();
      for (const via of first) {
        if (via === filePath) continue;
        for (const p of [...outOf(via), ...into(via)]) if (!first.has(p) && !second.has(p)) second.set(p, via);
      }
      result.secondHop = [];
      for (const [p, via] of [...second.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (budget <= 0) {
          omitted++;
          continue;
        }
        budget--;
        result.secondHop.push({ path: p, via, description: await describe(p) });
      }
    }
    result.omitted = omitted;
    return result;
  }

  /** Notes changed since `since` (newest first), for an agent picking up where the
   *  vault left off. `since` is an ISO date/time or a relative span: "36h", "7d",
   *  "2w". Excluded paths never appear. */
  async recentChanges(
    { since = "7d", limit = 50, path: dirPath = "" }: { since?: string; limit?: number; path?: string } = {},
  ): Promise<{ since: string; total: number; notes: Array<{ path: string; modified: string; created: boolean; description: string }> }> {
    if (dirPath) this.assertContained(dirPath, "Directory path");
    const cutoff = parseSince(since);
    const prefix = dirPath ? `${dirPath.replace(/\/+$/, "")}/` : "";
    const changed = this.readableMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix) && f.stat.mtime >= cutoff)
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    const notes = [];
    for (const f of changed.slice(0, Math.max(1, limit))) {
      notes.push({
        path: f.path,
        modified: new Date(f.stat.mtime).toISOString(),
        created: f.stat.ctime >= cutoff,
        description: await this.noteDescription(f),
      });
    }
    return { since: new Date(cutoff).toISOString(), total: changed.length, notes };
  }

  /** A health report on the vault (or one folder of it): what an agent or the owner
   *  should look at, never fixed automatically. Each check lists up to `limit`
   *  items and counts all of them. Excluded paths are not inspected. */
  async lintVault(
    { path: dirPath = "", limit = 50, stubBytes = 300 }: { path?: string; limit?: number; stubBytes?: number } = {},
  ): Promise<Record<string, { count: number; items: unknown[] }>> {
    if (dirPath) this.assertContained(dirPath, "Directory path");
    const prefix = dirPath ? `${dirPath.replace(/\/+$/, "")}/` : "";
    const files = this.readableMarkdownFiles().filter((f) => f.path.startsWith(prefix));
    const readable = new Set(this.readableMarkdownFiles().map((f) => f.path));
    const backlinks = this.getBacklinksIndex();
    const report: Record<string, { count: number; items: unknown[] }> = {};
    const add = (check: string, item: unknown) => {
      const r = (report[check] ??= { count: 0, items: [] });
      r.count++;
      if (r.items.length < limit) r.items.push(item);
    };
    const titles = new Map<string, string[]>();
    const tagSpellings = new Map<string, Map<string, number>>();
    for (const f of files) {
      const cache = this.app.metadataCache.getFileCache(f);
      const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
      for (const link of Object.keys(this.app.metadataCache.unresolvedLinks[f.path] ?? {})) {
        add("unresolvedLinks", { path: f.path, link });
      }
      const out = Object.keys(this.app.metadataCache.resolvedLinks[f.path] ?? {}).filter(
        (t) => t !== f.path && readable.has(t),
      );
      const inbound = (backlinks[f.path] ?? []).filter((src) => src !== f.path && readable.has(src));
      if (out.length === 0 && inbound.length === 0) add("orphans", f.path);
      if (f.stat.size < stubBytes) add("stubs", { path: f.path, bytes: f.stat.size });
      const hasDescription = ["description", "summary", "tldr"].some(
        (k) => typeof fm[k] === "string" && (fm[k]).trim() !== "",
      );
      if (!hasDescription && f.stat.size >= stubBytes) add("missingDescription", f.path);
      if (fm.ai_summary === true) add("unreviewedAiSummaries", { path: f.path, description: fm.description });
      const head = (await this.app.vault.cachedRead(f)).slice(0, 4000);
      if (!head.startsWith("---") && /^[^\n]{0,200}\n---\r?\n(?:[A-Za-z_][\w-]*:.*\r?\n|\s+-.*\r?\n)+---/.test(head)) {
        add("brokenFrontmatter", { path: f.path, problem: "text before the opening ---, so Obsidian sees no frontmatter" });
      } else if (/^---\r?\n/.test(head) && !cache?.frontmatterPosition) {
        add("brokenFrontmatter", { path: f.path, problem: "frontmatter block does not parse as YAML" });
      }
      const key = foldText(f.basename);
      titles.set(key, [...(titles.get(key) ?? []), f.path]);
      for (const tag of cache ? (getAllTags(cache) ?? []) : []) {
        const name = tag.replace(/^#/, "");
        const norm = name.toLowerCase().replace(/_/g, "-");
        const spellings = tagSpellings.get(norm) ?? new Map<string, number>();
        spellings.set(name, (spellings.get(name) ?? 0) + 1);
        tagSpellings.set(norm, spellings);
      }
    }
    for (const paths of titles.values()) if (paths.length > 1) add("duplicateTitles", paths);
    for (const spellings of tagSpellings.values()) {
      if (spellings.size > 1) add("tagVariants", Object.fromEntries(spellings));
    }
    for (const check of [
      "unresolvedLinks", "orphans", "stubs", "missingDescription",
      "unreviewedAiSummaries", "duplicateTitles", "tagVariants", "brokenFrontmatter",
    ]) report[check] ??= { count: 0, items: [] };
    return report;
  }

  /** Set or remove frontmatter fields on many notes in one call, each note in one
   *  write. With `dryRun` nothing is written and each entry shows the fields before
   *  and after. A note that cannot be read or patched reports an error and does not
   *  stop the others. */
  async updateFrontmatterMany(
    updates: Array<{ path: string; set?: Record<string, unknown>; unset?: string[] }>,
    dryRun: boolean,
  ): Promise<Array<{ path: string; changed: boolean; before?: Record<string, unknown>; after?: Record<string, unknown>; error?: string }>> {
    const results = [];
    for (const update of updates) {
      try {
        this.assertContained(update.path);
        const result = await this.withPathLocks([update.path], async () => {
          const file = this.app.vault.getAbstractFileByPath(update.path);
          if (!(file instanceof TFile)) throw new FileNotFoundError(`File not found: ${update.path}`);
          const original = await this.app.vault.read(file);
          let doc = original;
          const keys = [...Object.keys(update.set ?? {}), ...(update.unset ?? [])];
          const before = pickFrontmatter(doc, keys);
          for (const [key, value] of Object.entries(update.set ?? {})) {
            doc = patchV2(doc, {
              targetType: "frontmatter", target: key, operation: "replace", value, createTargetIfMissing: true,
            }).document;
          }
          for (const key of update.unset ?? []) {
            if (!(key in pickFrontmatter(doc, [key]))) continue;
            doc = patchV2(doc, {
              targetType: "frontmatter", target: key, operation: "delete", scope: "markerAndContent",
            }).document;
          }
          const changed = doc !== original;
          if (changed && !dryRun) await this.app.vault.modify(file, doc);
          return { path: update.path, changed, before, after: pickFrontmatter(doc, keys) };
        });
        results.push(result);
      } catch (error) {
        results.push({ path: update.path, changed: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  /** Rename a tag everywhere: in frontmatter `tags` lists and as inline `#tag` in
   *  the body (outside code), matching case-insensitively. With `nested`, `from/x`
   *  becomes `to/x` too. With `dryRun` nothing is written. Excluded notes are not
   *  touched. */
  async renameTag(
    from: string,
    to: string,
    { dryRun = true, nested = true }: { dryRun?: boolean; nested?: boolean } = {},
  ): Promise<{ from: string; to: string; dryRun: boolean; files: Array<{ path: string; frontmatter: number; inline: number }> }> {
    const src = from.replace(/^#/, "").trim();
    const dst = to.replace(/^#/, "").trim();
    if (!src || !dst || /\s/.test(dst)) throw new Error("from and to must be non-empty tag names without spaces.");
    const lower = src.toLowerCase();
    const rename = (tag: string): string | null => {
      const t = tag.replace(/^#/, "");
      const l = t.toLowerCase();
      if (l === lower) return dst;
      if (nested && l.startsWith(`${lower}/`)) return dst + t.slice(src.length);
      return null;
    };
    const inlineRe = new RegExp(
      `(?<![\\p{L}\\p{N}_/&#\\]])#(${escapeRegExp(src)}${nested ? "(?:/[\\p{L}\\p{N}_\\-/]+)?" : ""})(?![\\p{L}\\p{N}_\\-/])`,
      "giu",
    );
    const files = [];
    for (const file of this.readableMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const tags = cache ? (getAllTags(cache) ?? []) : [];
      if (!tags.some((t) => rename(t) !== null)) continue;
      const outcome = await this.withPathLocks([file.path], async () => {
        const original = await this.app.vault.read(file);
        let doc = original;
        let fmCount = 0;
        const fmTags: unknown = (cache?.frontmatter as Record<string, unknown> | undefined)?.tags;
        const list: unknown[] | null = Array.isArray(fmTags)
          ? (fmTags as unknown[])
          : typeof fmTags === "string"
            ? fmTags.split(/[,\s]+/).filter(Boolean)
            : null;
        if (list) {
          const next = list.map((t) => {
            const r = typeof t === "string" ? rename(t) : null;
            if (r !== null) fmCount++;
            return r ?? t;
          });
          if (fmCount > 0) {
            const deduped = next.filter((t, i) => next.indexOf(t) === i);
            doc = patchV2(doc, { targetType: "frontmatter", target: "tags", operation: "replace", value: deduped }).document;
          }
        }
        const fmEnd = frontmatterEnd(doc);
        let inline = 0;
        const parts = doc.slice(fmEnd).split(/(```[\s\S]*?```|`[^`\n]*`)/);
        for (let i = 0; i < parts.length; i += 2) {
          parts[i] = parts[i].replace(inlineRe, (_m, tag: string) => {
            const r = rename(tag);
            if (r === null) return _m;
            inline++;
            return `#${r}`;
          });
        }
        doc = doc.slice(0, fmEnd) + parts.join("");
        if (doc !== original && !dryRun) await this.app.vault.modify(file, doc);
        return { path: file.path, frontmatter: fmCount, inline };
      });
      if (outcome.frontmatter + outcome.inline > 0) files.push(outcome);
    }
    return { from: src, to: dst, dryRun, files };
  }

  async listVaultDirectory(dirPath: string): Promise<string[]> {
    this.assertContained(dirPath, "Directory path");
    const normalizedPath = dirPath.endsWith("/")
      ? dirPath.slice(0, -1)
      : dirPath;
    const prefix = normalizedPath ? normalizedPath + "/" : "";
    const files = [
      ...new Set(
        this.app.vault
          .getFiles()
          .map((e) => e.path)
          .filter((filename) => filename.startsWith(prefix))
          .filter((filename) => !this.isPathExcluded(filename))
          .map((filename) => {
            const subPath = filename.slice(prefix.length);
            if (subPath.indexOf("/") > -1) {
              return subPath.slice(0, subPath.indexOf("/") + 1);
            }
            return subPath;
          }),
      ),
    ];
    files.sort();
    return files;
  }

  async readFileContent(filePath: string): Promise<string> {
    this.assertContained(filePath);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return this.app.vault.read(file);
  }

  // Reads a file as raw bytes rather than decoding it as UTF-8, which is what
  // `readFileContent` above (and `cachedRead` behind `getFileMetadataObject`) does. The
  // REST layer reaches for `adapter.readBinary` directly; MCP goes through here so the
  // "does this file exist" answer is the same one `vault_read` gives.
  async readBinaryFileContent(filePath: string): Promise<ArrayBuffer> {
    this.assertContained(filePath);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return this.app.vault.adapter.readBinary(filePath);
  }

  /**
   * Run `write` once every write already queued on any of `paths` has finished,
   * holding those paths until it does.
   *
   * Without this, a conditional write is a check and a write separated by an
   * `await`, and another request's write can land in between: two clients that
   * both read version A and both send `If-Match: A` could each pass the check
   * before either writes, and the second would silently discard the first --
   * the exact lost update the precondition exists to prevent. Every mutating
   * operation in this class queues here, conditional or not, because an
   * unconditional write slipping between a check and its write breaks the
   * guarantee just as surely.
   *
   * This orders writes made through this API only. Obsidian's own editor, sync
   * plugins and other programs touching the files are outside it, as they are
   * outside any lock a plugin could take.
   *
   * Every path's tail is replaced synchronously, before any waiting starts, so
   * the queue order is the call order and two writes over overlapping path sets
   * cannot wait on each other in a cycle.
   */
  private async withPathLocks<T>(
    paths: string[],
    write: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(paths)];
    const predecessors = keys.map((key) => this.pathLocks.get(key));
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const key of keys) this.pathLocks.set(key, tail);
    try {
      await Promise.all(predecessors);
      return await write();
    } finally {
      release();
      for (const key of keys) {
        if (this.pathLocks.get(key) === tail) this.pathLocks.delete(key);
      }
    }
  }

  /**
   * Whether anything exists at `filePath`, and if it is a file, its version
   * token: markdown-patch's `versionOf` over the file's bytes. That is the value
   * served as the file's `ETag`, the document map's `version`, and what a PATCH
   * instruction's `ifMatch` is checked against.
   */
  async getFileState(filePath: string): Promise<CurrentFileState> {
    this.assertEntryContained(filePath);
    const stat = await this.app.vault.adapter.stat(filePath);
    if (!stat) return { exists: false, version: null };
    if (stat.type !== "file") return { exists: true, version: null };
    const bytes = await this.app.vault.adapter.readBinary(filePath);
    return { exists: true, version: versionOf(new Uint8Array(bytes)) };
  }

  /** Throw {@link PreconditionFailedError} unless `preconditions` hold for the
   *  file at `filePath` as it stands now. Callers hold the path's lock. */
  private async enforcePreconditions(
    filePath: string,
    preconditions: WritePreconditions | undefined,
  ): Promise<void> {
    if (!preconditions || !hasPreconditions(preconditions)) return;
    const failure = preconditionFailure(await this.getFileState(filePath), preconditions);
    if (failure !== null) {
      throw new PreconditionFailedError(failure);
    }
  }

  /**
   * Create or overwrite a file. Returns the version token of what was written,
   * for the caller to hand back as the new `ETag`.
   */
  async writeFileContent(
    filePath: string,
    content: string | Buffer,
    preconditions?: WritePreconditions,
  ): Promise<string> {
    this.assertContained(filePath);
    return this.withPathLocks([filePath], async () => {
      await this.enforcePreconditions(filePath, preconditions);
      try {
        await this.app.vault.createFolder(path.dirname(filePath));
      } catch {
        // folder already exists
      }
      if (typeof content === "string") {
        const existing = this.app.vault.getAbstractFileByPath(filePath);
        if (existing instanceof TFile) {
          await this.app.vault.modify(existing, content);
        } else {
          await this.app.vault.create(filePath, content);
        }
        return versionOf(content);
      }
      await this.app.vault.adapter.writeBinary(
        filePath,
        toArrayBuffer(content),
      );
      return versionOf(content);
    });
  }

  /**
   * Append to a file, creating it if it does not exist. Returns the version
   * token of the file's resulting content.
   */
  async appendFileContent(
    filePath: string,
    content: string,
    preconditions?: WritePreconditions,
  ): Promise<string> {
    this.assertContained(filePath);
    return this.withPathLocks([filePath], async () => {
      await this.enforcePreconditions(filePath, preconditions);
      try {
        await this.app.vault.createFolder(path.dirname(filePath));
      } catch {
        // folder already exists
      }
      let fileContents = "";
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        fileContents = await this.app.vault.read(file);
        if (!fileContents.endsWith("\n")) {
          fileContents += "\n";
        }
        fileContents += content;
        await this.app.vault.modify(file, fileContents);
        return versionOf(fileContents);
      }
      await this.app.vault.create(filePath, content);
      return versionOf(content);
    });
  }

  async deleteVaultFile(
    filePath: string,
    permanent = false,
    preconditions?: WritePreconditions,
  ): Promise<void> {
    this.assertEntryContained(filePath);
    return this.withPathLocks([filePath], async () => {
      await this.enforcePreconditions(filePath, preconditions);
      return this.deleteUnlocked(filePath, permanent);
    });
  }

  private async deleteUnlocked(filePath: string, permanent: boolean): Promise<void> {
    if (permanent) {
      const pathExists = await this.app.vault.adapter.exists(filePath);
      if (!pathExists) {
        throw new FileNotFoundError(`File not found: ${filePath}`);
      }
      await this.app.vault.adapter.remove(filePath);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) {
      throw new FileNotFoundError(`File not found: ${filePath}`);
    }
    await this.app.fileManager.trashFile(file);
  }

  /**
   * Move a file. `preconditions` apply to the source: the file being moved is
   * the one the client read. Whether the destination may be replaced is
   * `allowOverwrite`'s call.
   */
  async moveVaultFile(
    sourcePath: string,
    destinationPath: string,
    allowOverwrite = false,
    preconditions?: WritePreconditions,
  ): Promise<string> {
    this.assertEntryContained(sourcePath, "Source path");
    this.assertEntryContained(destinationPath, "Destination path");
    if (!destinationPath) {
      throw new Error("Destination path must not be empty.");
    }
    return this.withPathLocks([sourcePath, destinationPath], async () => {
      await this.enforcePreconditions(sourcePath, preconditions);
      return this.moveUnlocked(sourcePath, destinationPath, allowOverwrite);
    });
  }

  private async moveUnlocked(
    sourcePath: string,
    destinationPath: string,
    allowOverwrite: boolean,
  ): Promise<string> {
    if (sourcePath === destinationPath) {
      return sourcePath;
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) {
      throw new FileNotFoundError(`File not found: ${sourcePath}`);
    }

    const destExists = await this.app.vault.adapter.exists(destinationPath);
    if (destExists) {
      if (!allowOverwrite) {
        throw new DestinationAlreadyExistsError(
          `Destination already exists: ${destinationPath}`,
        );
      }
      await this.app.vault.adapter.remove(destinationPath);
    }

    const parentDir = destinationPath.substring(
      0,
      destinationPath.lastIndexOf("/"),
    );
    if (parentDir && !(await this.app.vault.adapter.exists(parentDir))) {
      await this.app.vault.createFolder(parentDir);
    }

    // @ts-ignore - fileManager exists at runtime but not in type definitions
    await this.app.fileManager.renameFile(sourceFile, destinationPath);
    return sourceFile.path;
  }

  /**
   * Copy a file. As with {@link moveVaultFile}, `preconditions` apply to the
   * source, so a client can copy exactly the version it read.
   */
  async copyVaultFile(
    sourcePath: string,
    destinationPath: string,
    allowOverwrite = false,
    preconditions?: WritePreconditions,
  ): Promise<string> {
    this.assertEntryContained(sourcePath, "Source path");
    this.assertEntryContained(destinationPath, "Destination path");
    if (!destinationPath) {
      throw new Error("Destination path must not be empty.");
    }
    return this.withPathLocks([sourcePath, destinationPath], async () => {
      await this.enforcePreconditions(sourcePath, preconditions);
      return this.copyUnlocked(sourcePath, destinationPath, allowOverwrite);
    });
  }

  private async copyUnlocked(
    sourcePath: string,
    destinationPath: string,
    allowOverwrite: boolean,
  ): Promise<string> {
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) {
      throw new FileNotFoundError(`File not found: ${sourcePath}`);
    }

    if (sourcePath === destinationPath) {
      throw new DestinationAlreadyExistsError(
        `Destination already exists: ${destinationPath}`,
      );
    }

    const destExists = await this.app.vault.adapter.exists(destinationPath);
    if (destExists) {
      if (!allowOverwrite) {
        throw new DestinationAlreadyExistsError(
          `Destination already exists: ${destinationPath}`,
        );
      }
      await this.app.vault.adapter.remove(destinationPath);
    }

    const parentDir = destinationPath.substring(
      0,
      destinationPath.lastIndexOf("/"),
    );
    if (parentDir && !(await this.app.vault.adapter.exists(parentDir))) {
      await this.app.vault.createFolder(parentDir);
    }

    const copiedFile = await this.app.vault.copy(sourceFile, destinationPath);
    return copiedFile.path;
  }

  // Throws PatchFailed on patch error; caller is responsible for mapping to
  // the appropriate HTTP error code or MCP error.
  async patchFileSection(
    filePath: string,
    targetType: PatchTargetType,
    target: string,
    operation: PatchOperation,
    content: unknown,
    contentType: string,
    options?: {
      createTargetIfMissing?: boolean;
      rejectIfContentPreexists?: boolean;
      trimTargetWhitespace?: boolean;
      targetDelimiter?: string;
      targetScope?: string;
    },
    preconditions?: WritePreconditions,
  ): Promise<string> {
    this.assertContained(filePath);
    return this.withPathLocks([filePath], async () => {
      await this.enforcePreconditions(filePath, preconditions);
      return this.patchFileSectionUnlocked(
        filePath, targetType, target, operation, content, contentType, options,
      );
    });
  }

  private async patchFileSectionUnlocked(
    filePath: string,
    targetType: PatchTargetType,
    target: string,
    operation: PatchOperation,
    content: unknown,
    contentType: string,
    options?: {
      createTargetIfMissing?: boolean;
      rejectIfContentPreexists?: boolean;
      trimTargetWhitespace?: boolean;
      targetDelimiter?: string;
      targetScope?: string;
    },
  ): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new FileNotFoundError(`File not found: ${filePath}`);
    }
    const fileContents = await this.app.vault.read(file);

    const delimiter = options?.targetDelimiter ?? "::";
    const resolvedTarget: string | string[] =
      targetType === "heading" ? target.split(delimiter) : target;

    const instruction: PatchInstruction = {
      operation,
      targetType,
      target: resolvedTarget,
      contentType,
      content,
      rejectIfContentPreexists: options?.rejectIfContentPreexists ?? false,
      trimTargetWhitespace: options?.trimTargetWhitespace ?? false,
      createTargetIfMissing: options?.createTargetIfMissing ?? false,
      ...(options?.targetScope ? { targetScope: options.targetScope } : {}),
    } as PatchInstruction;

    const patched = applyPatch(fileContents, instruction);
    await this.app.vault.modify(file, patched);
    return patched;
  }

  // Applies a single markdown-patch 2.0 instruction and writes the result.
  // ("Mdp2" = markdown-patch 2.0, not the removed API version 2.0 PATCH.)
  // Throws FileNotFoundError when the file is missing; lets the 2.0 engine's
  // typed errors (TargetNotFoundError, PreconditionFailedError, …) propagate for
  // the caller to map to HTTP responses. Returns the patched document alongside
  // any advisory warnings the engine surfaced (e.g. heading-depth overflow).
  //
  // `preconditions` are the request's If-Match/If-None-Match headers, checked
  // against the file's bytes; an instruction's own `ifMatch` is the engine's to
  // check, against the text it patches. Both must hold.
  async patchFileSectionMdp2(
    filePath: string,
    instruction: InstructionInput,
    preconditions?: WritePreconditions,
  ): Promise<PatchResult> {
    this.assertContained(filePath);
    return this.withPathLocks([filePath], async () => {
      await this.enforcePreconditions(filePath, preconditions);
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) {
        throw new FileNotFoundError(`File not found: ${filePath}`);
      }
      const fileContents = await this.app.vault.read(file);
      const result = patchV2(fileContents, instruction);
      await this.app.vault.modify(file, result.document);
      return result;
    });
  }

  /**
   * Ranked full-text search (BM25F over title, aliases, headings, tags, frontmatter
   * description and body), tuned for Vietnamese: a word matches with or without its
   * diacritics, old and new tone placement ("hoá"/"hóa") are the same word, an exact
   * accent and a whole-phrase match outrank loose ones, and a note matching only some
   * of the query's words is penalised. Each file's `matches` are best first: whole
   * phrases, then exact-accent words, then folded ones, then document order.
   */
  async simpleSearch(
    query: string,
    {
      contextLength = 100,
      maxResults = Infinity,
      maxMatchesPerFile = Infinity,
      path: folder,
      tags,
    }: SimpleSearchOptions = {},
  ): Promise<SimpleSearchResult> {
    if (folder) this.assertContained(folder, "Directory path");
    const { total, hits } = await this.vaultSearch.search(query, {
      limit: Number.isFinite(maxResults) ? maxResults : undefined,
      path: folder || undefined,
      tags: tags && tags.length ? tags : undefined,
    });
    const results: SearchResponseItem[] = [];
    const readable = new Map(this.readableMarkdownFiles().map((file) => [file.path, file]));

    for (const hit of hits) {
      const file = readable.get(hit.path);
      const content = file instanceof TFile ? await this.app.vault.cachedRead(file) : "";
      const basename = file instanceof TFile ? file.basename : hit.title;

      const contextMatches: SearchContext[] = [];
      const titleSpans = findMatches(basename, query);
      const contentSpans = findMatches(content, query);
      const totalMatches = titleSpans.length + contentSpans.length;

      for (const span of titleSpans) {
        if (contextMatches.length >= maxMatchesPerFile) break;
        contextMatches.push({
          match: { start: span.start, end: span.end, source: "filename" },
          context: basename,
        });
      }
      const headingAt = headingLocator(content);
      for (const span of contentSpans) {
        if (contextMatches.length >= maxMatchesPerFile) break;
        const heading = headingAt(span.start);
        contextMatches.push({
          ...(heading ? { heading } : {}),
          match: { start: span.start, end: span.end, source: "content" },
          context: content.slice(
            ...this.widenToCodePointBoundaries(
              content,
              Math.max(span.start - contextLength, 0),
              span.end + contextLength,
            ),
          ),
        });
      }

      results.push({
        filename: hit.path,
        score: hit.score,
        matches: contextMatches,
        totalMatches,
      });
    }

    void this.logSearch(query, folder, tags, total, results);
    return { results, totalResults: total };
  }

  /** Append one line per simple search to `search-log.jsonl` in this plugin's own
   *  folder (inside the configuration directory, so no API client can read it), for
   *  the owner to see which searches come back empty or weak. Rotated at 5 MB. Off
   *  when `logSearches` is false. Never throws: a failed log write must not fail a
   *  search. */
  private async logSearch(
    query: string,
    folder: string | undefined,
    tags: string[] | undefined,
    total: number,
    results: SearchResponseItem[],
  ): Promise<void> {
    if (this.settings.logSearches === false) return;
    const adapter = this.app.vault.adapter as unknown as {
      append?: (path: string, data: string) => Promise<void>;
      stat?: (path: string) => Promise<{ size: number } | null>;
      rename?: (from: string, to: string) => Promise<void>;
      exists?: (path: string) => Promise<boolean>;
      remove?: (path: string) => Promise<void>;
    };
    if (typeof adapter.append !== "function") return;
    const file = `${this.app.vault.configDir}/plugins/${LOCAL_REST_API_PLUGIN_ID}/search-log.jsonl`;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      query,
      ...(folder ? { path: folder } : {}),
      ...(tags && tags.length ? { tags } : {}),
      total,
      top: results.slice(0, 3).map((r) => ({ path: r.filename, score: r.score })),
    });
    try {
      const stat = await adapter.stat?.(file);
      if (stat && stat.size > 5 * 1024 * 1024 && adapter.rename) {
        const old = `${file}.1`;
        if (adapter.exists && adapter.remove && (await adapter.exists(old))) await adapter.remove(old);
        await adapter.rename(file, old);
      }
      await adapter.append(file, `${line}\n`);
    } catch (error) {
      console.warn("[REST API] could not write search log", error);
    }
  }

  async searchJsonLogic(
    query: unknown,
  ): Promise<SearchJsonResponseItem[]> {
    const results: SearchJsonResponseItem[] = [];
    const backlinksIndex = this.getBacklinksIndex();
    const includeContent = JSON.stringify(query).includes('"content"');

    for (const file of this.readableMarkdownFiles()) {
      const fileContext = await this.metadataObjectFor(file, backlinksIndex, includeContent);

      try {
        const fileResult = jsonLogic.apply(query, fileContext);

        if (this.isTruthy(fileResult)) {
          results.push({ filename: file.path, result: fileResult });
        }
      } catch (e) {
        const error = e as Error;
        throw new Error(`${error.message} (while processing ${file.path})`);
      }
    }

    return results;
  }

  private isTruthy(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(value);
  }

  /**
   * Widen a `[start, end)` UTF-16 code-unit range in `text` so that neither
   * end falls between the two halves of a surrogate pair. `String.prototype.slice`
   * works in code units, so a window computed from `contextLength` can bisect a
   * non-BMP character such as an emoji and hand back an unpaired surrogate
   * (e.g. `\udd0c`), which cannot be encoded as UTF-8. The range is only ever
   * grown, by at most one code unit per side: a `start` on a low surrogate
   * moves back to include its high surrogate, and an `end` just past a high
   * surrogate moves forward to include its low surrogate. Out-of-range bounds
   * and boundaries already on a whole code point are returned unchanged.
   * Lone surrogates already present in `text` are not repaired.
   *
   * This is deliberately not `String.prototype.toWellFormed()` (ES2024). That
   * method operates on an already-sliced string, so the missing half of the
   * pair is gone by the time it runs and the character cannot be recovered;
   * it substitutes U+FFFD (`\ufffd`) for each lone surrogate instead, which
   * would put a visible replacement character into user-facing search context
   * where the original emoji belongs. Widening the range before slicing keeps
   * the whole character.
   *
   * @param text The string the range indexes into.
   * @param start Inclusive start offset, in UTF-16 code units.
   * @param end Exclusive end offset, in UTF-16 code units.
   * @returns The `[start, end)` pair, widened where necessary, suitable for
   *   spreading into `text.slice`.
   */
  private widenToCodePointBoundaries(
    text: string,
    start: number,
    end: number,
  ): [number, number] {
    let widenedStart = start;
    if (widenedStart > 0 && widenedStart < text.length) {
      const codeUnit = text.charCodeAt(widenedStart);
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        widenedStart -= 1;
      }
    }
    let widenedEnd = end;
    if (widenedEnd > 0 && widenedEnd < text.length) {
      const codeUnit = text.charCodeAt(widenedEnd - 1);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        widenedEnd += 1;
      }
    }
    return [widenedStart, widenedEnd];
  }

  getAllTags(): Array<{ name: string; count: number }> {
    const tagCounts: Record<string, number> = {};
    for (const file of this.readableMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      const fileTags = getAllTags(cache);
      if (!fileTags) continue;
      for (const rawTag of fileTags) {
        const tag = rawTag.startsWith("#") ? rawTag.slice(1) : rawTag;
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        const parts = tag.split("/");
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          tagCounts[parent] = (tagCounts[parent] || 0) + 1;
        }
      }
    }
    const tags: { name: string; count: number }[] = [];
    for (const [tag, count] of Object.entries(tagCounts)) {
      if (!tag) continue;
      tags.push({ name: tag, count });
    }
    return tags;
  }

  listCommands(): Command[] {
    const commands: Command[] = [];
    for (const commandName in this.app.commands.commands) {
      commands.push({
        id: commandName,
        name: this.app.commands.commands[commandName].name,
      });
    }
    return commands;
  }

  executeCommand(commandId: string): void {
    const cmd = this.app.commands.commands[commandId];
    if (!cmd) {
      throw new CommandNotFoundError(`Command not found: ${commandId}`);
    }
    this.app.commands.executeCommandById(commandId);
  }

  openVaultFile(filePath: string, newLeaf = false): void {
    this.assertContained(filePath);
    // Intentionally fire-and-forget: the caller (POST /open/) has already
    // responded by the time this settles, since a client asking Obsidian to
    // focus a file has no reason to wait on that UI action finishing. The
    // rejection still needs a home, though -- an un-awaited promise with no
    // .catch is an unhandled rejection the moment openLinkText throws (e.g.
    // an invalid path), and while that's non-fatal in Obsidian's renderer
    // process, it's still an unexplained error with nothing to explain it.
    this.app.workspace.openLinkText(filePath, "/", newLeaf).catch((error) => {
      console.error(`[REST API] Failed to open "${filePath}":`, error);
    });
  }
}

function clip(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, " ");
  if (single.length <= maxChars) return single;
  const cut = [...single].slice(0, maxChars - 1).join("");
  return `${cut}…`;
}

/** Offset just past a leading YAML frontmatter block, or 0. For files the metadata
 *  cache has not described yet. */
function frontmatterEnd(content: string): number {
  if (!content.startsWith("---")) return 0;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return 0;
  const after = content.indexOf("\n", end + 4);
  return after === -1 ? content.length : after + 1;
}

/** A relative span ("36h", "7d", "2w") or an ISO date/time, as epoch milliseconds. */
function parseSince(since: string): number {
  const m = /^(\d+)\s*([hdw])$/i.exec(since.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase() as "h" | "d" | "w"];
    return Date.now() - n * unit;
  }
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`since: expected an ISO date or a span like "7d", got "${since}"`);
  return t;
}

/** The named top-level frontmatter fields of a document, parsed. Absent fields are
 *  left out. */
function pickFrontmatter(doc: string, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const end = frontmatterEnd(doc);
  if (keys.length === 0 || end === 0) return out;
  let fm: unknown;
  try {
    fm = parseYaml(doc.slice(4, doc.lastIndexOf("\n---", end)));
  } catch {
    return out;
  }
  if (!fm || typeof fm !== "object") return out;
  for (const k of keys) if (k in (fm as Record<string, unknown>)) out[k] = (fm as Record<string, unknown>)[k];
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A function from an offset in `content` to the heading path it sits under
 *  ("Setup > Docker"), or "" above the first heading. Headings inside code fences
 *  are ignored. */
function headingLocator(content: string): (offset: number) => string {
  const marks: Array<{ offset: number; path: string }> = [];
  const stack: Array<{ level: number; text: string }> = [];
  let inCode = false;
  let offset = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) inCode = !inCode;
    const h = !inCode && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (h) {
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: h[2] });
      marks.push({ offset, path: stack.map((s) => s.text).join(" > ") });
    }
    offset += line.length + 1;
  }
  return (at: number) => {
    let lo = 0;
    let hi = marks.length - 1;
    let found = "";
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid].offset <= at) {
        found = marks[mid].path;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
}
