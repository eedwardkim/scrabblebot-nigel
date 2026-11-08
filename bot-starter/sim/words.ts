// Dictionary + fast longest-word search that returns exactly what the
// server's findBestPlayable (spacetimedb/src/dictionary.ts) returns:
// the longest spellable word, ties broken by lexicographically smallest.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORDLIST_PATH = resolve(HERE, "../../spacetimedb/wordlist.txt");

const A = 65;

// Scrabble letter values, mirrors spacetimedb/src/letters.ts.
const VALUES: Record<string, number> = {
  A: 1, E: 1, I: 1, O: 1, U: 1, L: 1, N: 1, S: 1, T: 1, R: 1,
  D: 2, G: 2, B: 3, C: 3, M: 3, P: 3, F: 4, H: 4, V: 4, W: 4, Y: 4,
  K: 5, J: 8, X: 8, Q: 10, Z: 10,
};
export function letterValue(c: string): number {
  return VALUES[c] ?? 0;
}
export const LETTER_VALUE_BY_IDX: number[] = Array.from({ length: 26 }, (_, i) =>
  letterValue(String.fromCharCode(A + i)),
);

// Standard Scrabble distribution, no blanks. 98 tiles.
export const DEFAULT_BAG: readonly (readonly [string, number])[] = [
  ["A", 9], ["B", 2], ["C", 2], ["D", 4], ["E", 12], ["F", 2], ["G", 3],
  ["H", 2], ["I", 9], ["J", 1], ["K", 1], ["L", 4], ["M", 2], ["N", 6],
  ["O", 8], ["P", 2], ["Q", 1], ["R", 6], ["S", 4], ["T", 6], ["U", 4],
  ["V", 2], ["W", 2], ["X", 1], ["Y", 2], ["Z", 1],
];
export const BAG_COUNTS: number[] = DEFAULT_BAG.map(([, n]) => n);

// totalReward = floor(base * num / denom).
export function wordReward(word: string): number {
  let base = 0;
  for (const c of word) base += letterValue(c);
  const len = word.length;
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export interface WordIndex {
  set: Set<string>;
  words: string[]; // length desc, then lex asc
  len: Uint8Array;
  mask: Int32Array;
  counts: Uint8Array; // 26 per word
  // firstIdxAtMostLen[L] = first index whose word length <= L
  firstIdxAtMostLen: Int32Array;
}

let INDEX: WordIndex | undefined;

export function wordIndex(): WordIndex {
  if (INDEX) return INDEX;
  const raw = readFileSync(WORDLIST_PATH, "utf8").split("\n");
  const set = new Set<string>();
  for (const line of raw) {
    const w = line.trim().toUpperCase();
    if (w.length >= 2 && /^[A-Z]+$/.test(w)) set.add(w);
  }
  const words = [...set].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  const n = words.length;
  const len = new Uint8Array(n);
  const mask = new Int32Array(n);
  const counts = new Uint8Array(n * 26);
  let maxLen = 0;
  for (let i = 0; i < n; i++) {
    const w = words[i]!;
    len[i] = Math.min(w.length, 255);
    if (w.length > maxLen) maxLen = w.length;
    let m = 0;
    for (let k = 0; k < w.length; k++) {
      const s = w.charCodeAt(k) - A;
      m |= 1 << s;
      counts[i * 26 + s]!++;
    }
    mask[i] = m;
  }
  const firstIdxAtMostLen = new Int32Array(Math.max(maxLen, 256) + 1);
  for (let L = 0; L < firstIdxAtMostLen.length; L++) {
    // binary search: first i with len[i] <= L (len is non-increasing)
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (len[mid]! <= L) hi = mid;
      else lo = mid + 1;
    }
    firstIdxAtMostLen[L] = lo;
  }
  INDEX = { set, words, len, mask, counts, firstIdxAtMostLen };
  return INDEX;
}

export function isValidWord(word: string): boolean {
  return word.length >= 2 && wordIndex().set.has(word);
}

// rack: 26 counts. Returns the longest word (>= minLen) spellable from rack,
// ties lexicographically smallest; undefined if none.
export function findBestPlayableCounts(
  rack: ArrayLike<number>,
  minLen: number,
): string | undefined {
  const idx = wordIndex();
  let total = 0;
  let rmask = 0;
  for (let i = 0; i < 26; i++) {
    const c = rack[i]!;
    if (c > 0) {
      total += c;
      rmask |= 1 << i;
    }
  }
  if (total < minLen) return undefined;
  const { len, mask, counts, words } = idx;
  const start = idx.firstIdxAtMostLen[Math.min(total, idx.firstIdxAtMostLen.length - 1)]!;
  const notMask = ~rmask;
  for (let i = start; i < words.length; i++) {
    if (len[i]! < minLen) break;
    if ((mask[i]! & notMask) !== 0) continue;
    const base = i * 26;
    let ok = true;
    let m = mask[i]!;
    while (m !== 0) {
      const s = 31 - Math.clz32(m & -m);
      if (counts[base + s]! > rack[s]!) {
        ok = false;
        break;
      }
      m &= m - 1;
    }
    if (ok) return words[i];
  }
  return undefined;
}

export function rackMapToCounts(rack: Map<string, number>): number[] {
  const out = new Array<number>(26).fill(0);
  for (const [c, n] of rack) {
    if (/^[A-Z]$/.test(c)) out[c.charCodeAt(0) - A]! += n;
  }
  return out;
}

export function findBestPlayable(
  rack: Map<string, number>,
  minLen: number,
): string | undefined {
  return findBestPlayableCounts(rackMapToCounts(rack), minLen);
}

// Reference implementation: a literal port of the server's linear scan, used
// by the self-check to prove the fast path picks the same word.
export function findBestPlayableReference(
  rack: Map<string, number>,
  minLen: number,
): string | undefined {
  const rc = rackMapToCounts(rack);
  const total = rc.reduce((a, b) => a + b, 0);
  if (total < minLen) return undefined;
  const need = new Array<number>(26);
  for (const word of wordIndex().words) {
    if (word.length < minLen) break;
    if (word.length > total) continue;
    need.fill(0);
    for (let i = 0; i < word.length; i++) need[word.charCodeAt(i) - A]!++;
    if (need.every((n, i) => n <= rc[i]!)) return word;
  }
  return undefined;
}
