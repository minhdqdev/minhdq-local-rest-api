/**
 * Where a query matched inside a note's text, for the `matches` array simple search
 * returns. Pure: offsets are into the string given, so the caller can slice context
 * from the very text it read.
 */
import { accentKey, foldKey, nfc, TOKEN_RE } from "./text";

export interface MatchSpan {
  start: number;
  end: number;
  /** Higher is better: a run of consecutive query words beats a lone word, and a
   *  word typed with its exact diacritics beats one that only matches folded. */
  quality: number;
}

interface Token {
  start: number;
  end: number;
  accent: string;
  fold: string;
}

function tokensWithOffsets(text: string): Token[] {
  const out: Token[] = [];
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = nfc(m[0]).toLowerCase();
    out.push({ start: m.index, end: m.index + m[0].length, accent: accentKey(word), fold: foldKey(word) });
  }
  return out;
}

/**
 * Every place `query` matches `text`, best first (then in document order). A run of
 * consecutive text words that are consecutive query words is one span, so searching
 * "nguồn cung sản phẩm" reports the phrase once rather than four separate words.
 */
export function findMatches(text: string, query: string): MatchSpan[] {
  const q = tokensWithOffsets(query);
  if (q.length === 0) return [];
  const qFold = q.map((t) => t.fold);
  const qAccent = q.map((t) => t.accent);
  const wanted = new Set(qFold);

  const tokens = tokensWithOffsets(text);
  const spans: MatchSpan[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!wanted.has(tokens[i].fold)) continue;
    // The longest run starting here that follows the query word order.
    let bestLen = 1;
    let bestExact = qAccent.includes(tokens[i].accent) ? 1 : 0;
    for (let k = 0; k < q.length; k++) {
      if (qFold[k] !== tokens[i].fold) continue;
      let len = 0;
      let exact = 0;
      while (
        i + len < tokens.length &&
        k + len < q.length &&
        tokens[i + len].fold === qFold[k + len]
      ) {
        if (tokens[i + len].accent === qAccent[k + len]) exact++;
        len++;
      }
      if (len > bestLen || (len === bestLen && exact > bestExact)) {
        bestLen = len;
        bestExact = exact;
      }
    }
    spans.push({
      start: tokens[i].start,
      end: tokens[i + bestLen - 1].end,
      quality: (bestLen - 1) * 4 + 1 + bestExact,
    });
    i += bestLen - 1;
  }
  return spans.sort((a, b) => b.quality - a.quality || a.start - b.start);
}
