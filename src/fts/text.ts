/**
 * Vietnamese-aware text normalisation. Pure functions, no Obsidian imports, so the
 * engine can be tested in plain Node.
 *
 * Every token is indexed under two keys:
 *
 * - accent key: NFC, lower case, vowel-quality marks (â ă ê ô ơ ư đ) kept, and the tone
 *   mark moved off the vowel to the end of the syllable. "hoá" (old-style placement) and
 *   "hóa" (new-style) therefore share one key, `hoa~1`, while "cung" and "cùng" stay
 *   apart.
 * - fold key: every diacritic removed and đ → d, so "san pham" still finds "sản phẩm".
 */

// Combining tone marks: grave, acute, tilde, hook above, dot below.
const TONE_MARKS: Record<string, string> = {
  "̀": "2", // huyền
  "́": "1", // sắc
  "̃": "4", // ngã
  "̉": "3", // hỏi
  "̣": "5", // nặng
};
const TONE_RE = /[̣̀́̃̉]/g;
const COMBINING_RE = /[̀-ͯ]/g;
// \p{M}: combining marks stay inside a token, so text that reaches us decomposed
// (NFD, as macOS sometimes stores it) is not split in the middle of "ế".
export const TOKEN_RE = /[\p{L}\p{M}\p{N}]+/gu;

export function nfc(text: string): string {
  return text.normalize("NFC");
}

/** Lower-cased NFC tokens, in order, duplicates kept. */
export function tokenize(text: string): string[] {
  return nfc(text).toLowerCase().match(TOKEN_RE) ?? [];
}

export function accentKey(token: string): string {
  const decomposed = token.normalize("NFD");
  let tone = "";
  const base = decomposed.replace(TONE_RE, (mark) => {
    tone = TONE_MARKS[mark] ?? tone;
    return "";
  });
  const recomposed = base.normalize("NFC");
  return tone ? `${recomposed}~${tone}` : recomposed;
}

export function foldKey(token: string): string {
  return token
    .normalize("NFD")
    .replace(COMBINING_RE, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .normalize("NFC");
}

/** True when a lower-cased token carries any Vietnamese/Latin diacritic. */
export function hasDiacritics(token: string): boolean {
  return foldKey(token) !== token;
}

/** Fold a whole string for loose comparisons (paths, titles). */
export function foldText(text: string): string {
  return tokenize(text).map(foldKey).join(" ");
}

export function accentText(text: string): string {
  return tokenize(text).map(accentKey).join(" ");
}
