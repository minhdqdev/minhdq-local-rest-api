/**
 * A small in-memory BM25F index tuned for a Vietnamese/English notes vault.
 * Pure TypeScript: the Obsidian plugin feeds it documents, tests feed it fixtures.
 */
import { accentKey, accentText, foldKey, foldText, hasDiacritics, tokenize } from "./text";

export type FieldName = "title" | "alias" | "heading" | "tag" | "meta" | "body";

export interface SearchDocument {
  path: string;
  title: string;
  aliases?: string[];
  headings?: string[];
  tags?: string[];
  /** Short frontmatter text such as `description` or `summary`. */
  meta?: string;
  body?: string;
}

export interface SearchOptions {
  /** Most hits to return; all of them when absent. */
  limit?: number;
  /** Only paths starting with this folder (compared without diacritics or case). */
  path?: string;
  /** Keep a note if it has any of these tags; `ai` also matches `ai/coding-agent`. */
  tags?: string[];
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  /** Fields where at least one query term matched. */
  matchedIn: FieldName[];
  /** Share of distinct query terms found anywhere in the note, 0–1. */
  coverage: number;
  tags: string[];
  meta?: string;
}

const FIELDS: FieldName[] = ["title", "alias", "heading", "tag", "meta", "body"];

const BOOST: Record<FieldName, number> = {
  title: 6,
  alias: 5,
  heading: 2.5,
  tag: 2,
  meta: 2.5,
  body: 1,
};

// Length normalisation: short fields barely care about length.
const B: Record<FieldName, number> = {
  title: 0.3,
  alias: 0.3,
  heading: 0.5,
  tag: 0.2,
  meta: 0.5,
  body: 0.75,
};
const K1 = 1.2;
const PHRASE_WEIGHT = 1.5;

type Kind = "a" | "f"; // accent key / fold key
type Postings = Map<number, number>; // docId -> term frequency

interface StoredDoc {
  id: number;
  path: string;
  title: string;
  tags: string[];
  meta?: string;
  lengths: Record<FieldName, number>;
  keys: string[];
  titleAccent: string;
  titleFold: string;
  aliasAccent: string[];
  aliasFold: string[];
}

export class SearchIndex {
  private docs = new Map<number, StoredDoc>();
  private byPath = new Map<string, number>();
  private postings = new Map<string, Postings>();
  private totalLength: Record<FieldName, number> = {
    title: 0, alias: 0, heading: 0, tag: 0, meta: 0, body: 0,
  };
  private nextId = 0;

  get size(): number {
    return this.docs.size;
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  clear(): void {
    this.docs.clear();
    this.byPath.clear();
    this.postings.clear();
    for (const f of FIELDS) this.totalLength[f] = 0;
  }

  upsert(doc: SearchDocument): void {
    this.remove(doc.path);
    const id = this.nextId++;
    const fieldText: Record<FieldName, string[]> = {
      title: [doc.title],
      alias: doc.aliases ?? [],
      heading: doc.headings ?? [],
      tag: (doc.tags ?? []).map((t) => t.replace(/^#/, "").replace(/[/_-]/g, " ")),
      meta: doc.meta ? [doc.meta] : [],
      body: doc.body ? [doc.body] : [],
    };
    const keys = new Set<string>();
    const lengths = { title: 0, alias: 0, heading: 0, tag: 0, meta: 0, body: 0 } as Record<FieldName, number>;

    for (const field of FIELDS) {
      for (const text of fieldText[field]) {
        const tokens = tokenize(text);
        lengths[field] += tokens.length;
        const acc = tokens.map(accentKey);
        const fold = tokens.map(foldKey);
        this.addTerms(id, field, "a", acc, keys);
        this.addTerms(id, field, "f", fold, keys);
        this.addTerms(id, field, "a", bigrams(acc), keys, "2");
        this.addTerms(id, field, "f", bigrams(fold), keys, "2");
      }
      this.totalLength[field] += lengths[field];
    }

    this.docs.set(id, {
      id,
      path: doc.path,
      title: doc.title,
      tags: (doc.tags ?? []).map(normaliseTag),
      meta: doc.meta,
      lengths,
      keys: [...keys],
      titleAccent: accentText(doc.title),
      titleFold: foldText(doc.title),
      aliasAccent: (doc.aliases ?? []).map(accentText),
      aliasFold: (doc.aliases ?? []).map(foldText),
    });
    this.byPath.set(doc.path, id);
  }

  remove(path: string): void {
    const id = this.byPath.get(path);
    if (id === undefined) return;
    const doc = this.docs.get(id);
    for (const key of doc.keys) {
      const p = this.postings.get(key);
      if (!p) continue;
      p.delete(id);
      if (p.size === 0) this.postings.delete(key);
    }
    for (const f of FIELDS) this.totalLength[f] -= doc.lengths[f];
    this.docs.delete(id);
    this.byPath.delete(path);
  }

  rename(oldPath: string, doc: SearchDocument): void {
    this.remove(oldPath);
    this.upsert(doc);
  }

  search(query: string, options: SearchOptions = {}): { total: number; hits: SearchHit[] } {
    const limit = options.limit === undefined ? Infinity : Math.max(1, Math.floor(options.limit));
    const qTokens = dedupe(tokenize(query));
    if (qTokens.length === 0) return { total: 0, hits: [] };

    const qAcc = qTokens.map(accentKey);
    const qFold = qTokens.map(foldKey);
    // A query term typed with diacritics is deliberate: a fold-only match ("cùng" for
    // "cung") is a weak signal. A bare ASCII term may just be lazy typing.
    const foldWeight = qTokens.map((t) => (hasDiacritics(t) ? 0.3 : 0.7));
    const N = this.docs.size || 1;

    const scores = new Map<number, number>();
    const matchedTerms = new Map<number, Set<number>>();
    const matchedFields = new Map<number, Set<FieldName>>();
    const allowed = this.filter(options);

    const bump = (doc: number, value: number, term: number | null, field: FieldName) => {
      if (allowed && !allowed.has(doc)) return;
      scores.set(doc, (scores.get(doc) ?? 0) + value);
      if (term !== null) {
        let s = matchedTerms.get(doc);
        if (!s) matchedTerms.set(doc, (s = new Set()));
        s.add(term);
      }
      let fs = matchedFields.get(doc);
      if (!fs) matchedFields.set(doc, (fs = new Set()));
      fs.add(field);
    };

    for (const field of FIELDS) {
      const avg = this.totalLength[field] / N || 1;
      const boost = BOOST[field];

      qTokens.forEach((_, i) => {
        const pa = this.postings.get(key(field, "a", qAcc[i]));
        const pf = this.postings.get(key(field, "f", qFold[i]));
        const idfA = idf(N, pa?.size ?? 0);
        const idfF = idf(N, pf?.size ?? 0);
        const docsHere = new Set<number>([...(pa?.keys() ?? []), ...(pf?.keys() ?? [])]);
        for (const d of docsHere) {
          const len = this.docs.get(d).lengths[field];
          const tfA = pa?.get(d) ?? 0;
          const tfF = Math.max(0, (pf?.get(d) ?? 0) - tfA);
          const s =
            idfA * bm25(tfA, len, avg, B[field]) +
            foldWeight[i] * idfF * bm25(tfF, len, avg, B[field]);
          if (s > 0) bump(d, boost * s, i, field);
        }
      });

      // Phrase signal: consecutive query terms appearing next to each other.
      for (let i = 0; i + 1 < qTokens.length; i++) {
        const pa = this.postings.get(key(field, "a", `${qAcc[i]} ${qAcc[i + 1]}`, "2"));
        const pf = this.postings.get(key(field, "f", `${qFold[i]} ${qFold[i + 1]}`, "2"));
        const idfA = idf(N, pa?.size ?? 0);
        const idfF = idf(N, pf?.size ?? 0);
        const docsHere = new Set<number>([...(pa?.keys() ?? []), ...(pf?.keys() ?? [])]);
        const w = Math.min(foldWeight[i], foldWeight[i + 1]);
        for (const d of docsHere) {
          const len = this.docs.get(d).lengths[field];
          const tfA = pa?.get(d) ?? 0;
          const tfF = Math.max(0, (pf?.get(d) ?? 0) - tfA);
          const s = idfA * bm25(tfA, len, avg, B[field]) + w * idfF * bm25(tfF, len, avg, B[field]);
          if (s > 0) bump(d, boost * PHRASE_WEIGHT * s, null, field);
        }
      }
    }

    const qAccText = qAcc.join(" ");
    const qFoldText = qFold.join(" ");
    const hits: SearchHit[] = [];
    for (const [d, raw] of scores) {
      const doc = this.docs.get(d);
      const coverage = (matchedTerms.get(d)?.size ?? 0) / qTokens.length;
      let score = raw * coverage * coverage;
      score *= 1 + titleBonus(doc, qAccText, qFoldText);
      hits.push({
        path: doc.path,
        title: doc.title,
        score: Math.round(score * 100) / 100,
        matchedIn: FIELDS.filter((f) => matchedFields.get(d)?.has(f)),
        coverage: Math.round(coverage * 100) / 100,
        tags: doc.tags,
        meta: doc.meta,
      });
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { total: hits.length, hits: hits.slice(0, limit) };
  }

  private filter(options: SearchOptions): Set<number> | null {
    if (!options.path && !(options.tags && options.tags.length)) return null;
    const prefix = options.path ? foldPath(options.path) : null;
    const tags = (options.tags ?? []).map(normaliseTag).filter(Boolean);
    const out = new Set<number>();
    for (const doc of this.docs.values()) {
      if (prefix && !foldPath(doc.path).startsWith(prefix)) continue;
      if (tags.length && !doc.tags.some((t) => tags.some((q) => t === q || t.startsWith(`${q}/`)))) continue;
      out.add(doc.id);
    }
    return out;
  }

  private addTerms(id: number, field: FieldName, kind: Kind, terms: string[], keys: Set<string>, n = "1"): void {
    for (const term of terms) {
      const k = key(field, kind, term, n);
      let p = this.postings.get(k);
      if (!p) this.postings.set(k, (p = new Map<number, number>()));
      p.set(id, (p.get(id) ?? 0) + 1);
      keys.add(k);
    }
  }
}

function titleBonus(doc: StoredDoc, qAcc: string, qFold: string): number {
  const exact = (t: string, q: string) => t === q;
  const contains = (t: string, q: string) => ` ${t} `.includes(` ${q} `);
  let bonus = 0;
  const check = (acc: string, fold: string, scale: number) => {
    if (exact(acc, qAcc)) bonus = Math.max(bonus, 3 * scale);
    else if (exact(fold, qFold)) bonus = Math.max(bonus, 2 * scale);
    else if (contains(acc, qAcc)) bonus = Math.max(bonus, 1.5 * scale);
    else if (contains(fold, qFold)) bonus = Math.max(bonus, 1 * scale);
  };
  check(doc.titleAccent, doc.titleFold, 1);
  doc.aliasAccent.forEach((a, i) => check(a, doc.aliasFold[i], 0.9));
  return bonus;
}

function key(field: FieldName, kind: Kind, term: string, n = "1"): string {
  return `${field}|${kind}${n}|${term}`;
}

function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function idf(N: number, df: number): number {
  if (df === 0) return 0;
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

function bm25(tf: number, len: number, avg: number, b: number): number {
  if (tf <= 0) return 0;
  return (tf * (K1 + 1)) / (tf + K1 * (1 - b + (b * len) / avg));
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}


function normaliseTag(tag: string): string {
  return tag.replace(/^#/, "").normalize("NFC").toLowerCase();
}

function foldPath(path: string): string {
  return path.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
}
