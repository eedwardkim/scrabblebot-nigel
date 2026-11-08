// Word engine: dictionary, scoring that matches the server's integer math,
// an anagram trie over sorted letters, best single word and best partition.
//
// Racks are 26-slot count arrays (index 0 = 'A'). Everything here is
// synchronous and cached by rack key, so callers must keep racks small
// (the strategy cashes out long before racks get huge).

import * as fs from "node:fs";
import * as path from "node:path";

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};
export const VALUES: number[] = Array.from({ length: 26 }, (_, i) =>
  LETTER_VALUE[String.fromCharCode(65 + i)]!,
);

export const BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4,
  M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1,
  Y: 2, Z: 1,
};

// Server: lengthMultiplier as (num, denom); reward = base * num / denom
// with bigint (floor) division.
export function multiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}
export function rewardFor(base: number, len: number): number {
  const [n, d] = multiplier(len);
  return Math.floor((base * n) / d);
}
export function wordReward(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  return rewardFor(base, word.length);
}

// ---------- Dictionary + sorted-letter trie ----------

const DICT_PATH =
  process.env.WORDLIST ??
  path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "spacetimedb",
    "wordlist.txt",
  );

export const WORDS = new Set<string>();
// Trie over each word's letters sorted A..Z. Edge key = node * 26 + letter.
const edges = new Map<number, number>();
// node -> one word spelling exactly that multiset (all anagrams score the same).
const terminal = new Map<number, string>();
let nodeCount = 1;

function loadDictionary() {
  const text = fs.readFileSync(DICT_PATH, "utf8");
  for (const raw of text.split("\n")) {
    const w = raw.trim().toUpperCase();
    if (w.length < 2 || !/^[A-Z]+$/.test(w)) continue;
    WORDS.add(w);
    const codes = Array.from(w, (c) => c.charCodeAt(0) - 65).sort((a, b) => a - b);
    let node = 0;
    for (const c of codes) {
      const k = node * 26 + c;
      let nxt = edges.get(k);
      if (nxt === undefined) {
        nxt = nodeCount++;
        edges.set(k, nxt);
      }
      node = nxt;
    }
    if (!terminal.has(node)) terminal.set(node, w);
  }
}
loadDictionary();

export function isWord(w: string): boolean {
  return WORDS.has(w);
}

// ---------- Racks ----------

export type Counts = number[]; // length 26

export function toCounts(rack: Map<string, number> | string): Counts {
  const c = new Array<number>(26).fill(0);
  if (typeof rack === "string") {
    for (const ch of rack) {
      const i = ch.charCodeAt(0) - 65;
      if (i >= 0 && i < 26) c[i]!++;
    }
  } else {
    for (const [ch, n] of rack) {
      const i = ch.charCodeAt(0) - 65;
      if (i >= 0 && i < 26 && n > 0) c[i]! += n;
    }
  }
  return c;
}
export function countsKey(c: Counts): string {
  let s = "";
  for (let i = 0; i < 26; i++) for (let k = 0; k < c[i]!; k++) s += String.fromCharCode(65 + i);
  return s;
}
export function tileCount(c: Counts): number {
  let n = 0;
  for (const x of c) n += x;
  return n;
}
export function canSpell(word: string, c: Counts): boolean {
  const need = new Array<number>(26).fill(0);
  for (const ch of word) {
    const i = ch.charCodeAt(0) - 65;
    if (i < 0 || i >= 26) return false;
    if (++need[i]! > c[i]!) return false;
  }
  return true;
}

export interface Cand {
  word: string;
  reward: number;
  len: number;
  counts: Counts;
}

// Every dictionary multiset contained in the rack (one representative word
// each), found by walking the sorted-letter trie. Cached by rack key.
const candCache = new Map<string, Cand[]>();
export function candidates(c: Counts): Cand[] {
  const key = countsKey(c);
  const hit = candCache.get(key);
  if (hit) return hit;
  const out: Cand[] = [];
  const used = new Array<number>(26).fill(0);
  const walk = (node: number, from: number, len: number, base: number) => {
    if (len >= 2) {
      const w = terminal.get(node);
      if (w !== undefined) {
        out.push({ word: w, reward: rewardFor(base, len), len, counts: used.slice() });
      }
    }
    for (let i = from; i < 26; i++) {
      if (used[i]! >= c[i]!) continue;
      const nxt = edges.get(node * 26 + i);
      if (nxt === undefined) continue;
      used[i]!++;
      // Same letter may repeat: stay at i.
      walk(nxt, i, len + 1, base + VALUES[i]!);
      used[i]!--;
    }
  };
  walk(0, 0, 0, 0);
  out.sort((a, b) => b.reward - a.reward || b.len - a.len);
  if (candCache.size > 50_000) candCache.clear();
  candCache.set(key, out);
  return out;
}

export function bestWord(c: Counts): Cand | undefined {
  return candidates(c)[0];
}

// Upper bound on what `rest` can still score: every tile in one word.
function bound(rest: Counts): number {
  let base = 0;
  let n = 0;
  for (let i = 0; i < 26; i++) {
    base += VALUES[i]! * rest[i]!;
    n += rest[i]!;
  }
  return n < 2 ? 0 : rewardFor(base, n);
}

export interface Partition {
  total: number;
  words: string[];
}

// Max total reward from disjoint words out of the rack (leftovers score 0).
// Branch-and-bound over candidates sorted by reward, with a node budget so
// it can never stall the event loop.
const partCache = new Map<string, Partition>();
export function bestPartition(c: Counts, nodeBudget = 40_000): Partition {
  const key = countsKey(c);
  const hit = partCache.get(key);
  if (hit) return hit;
  const cands = candidates(c);
  let best: Partition = { total: 0, words: [] };
  if (cands.length === 0) {
    partCache.set(key, best);
    return best;
  }
  const rest = c.slice();
  const chosen: string[] = [];
  let nodes = 0;
  const fits = (cc: Counts) => {
    for (let i = 0; i < 26; i++) if (cc[i]! > rest[i]!) return false;
    return true;
  };
  const dfs = (start: number, acc: number) => {
    if (acc > best.total) best = { total: acc, words: chosen.slice() };
    if (++nodes > nodeBudget) return;
    if (acc + bound(rest) <= best.total) return;
    for (let k = start; k < cands.length; k++) {
      const cand = cands[k]!;
      if (!fits(cand.counts)) continue;
      for (let i = 0; i < 26; i++) rest[i]! -= cand.counts[i]!;
      chosen.push(cand.word);
      dfs(k, acc + cand.reward);
      chosen.pop();
      for (let i = 0; i < 26; i++) rest[i]! += cand.counts[i]!;
      if (nodes > nodeBudget) return;
    }
  };
  dfs(0, 0);
  if (partCache.size > 50_000) partCache.clear();
  partCache.set(key, best);
  return best;
}

export function addLetter(c: Counts, letter: string, n = 1): Counts {
  const out = c.slice();
  const i = letter.charCodeAt(0) - 65;
  if (i >= 0 && i < 26) out[i]! += n;
  return out;
}
export function subtractWord(c: Counts, word: string): Counts {
  const out = c.slice();
  for (const ch of word) out[ch.charCodeAt(0) - 65]!--;
  return out;
}
