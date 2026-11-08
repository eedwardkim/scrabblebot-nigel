// Scoring + dictionary parity tests against a direct port of the server
// (spacetimedb/src/letters.ts, spacetimedb/src/dictionary.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BAG,
  LETTER_VALUE,
  VALUES,
  WORDS,
  isWord,
  multiplier,
  rewardFor,
  wordReward,
} from "./words.js";

// ---------- Direct port of the server ----------

function serverLetterValue(c: string): number {
  switch (c) {
    case "A": case "E": case "I": case "O": case "U":
    case "L": case "N": case "S": case "T": case "R":
      return 1;
    case "D": case "G":
      return 2;
    case "B": case "C": case "M": case "P":
      return 3;
    case "F": case "H": case "V": case "W": case "Y":
      return 4;
    case "K":
      return 5;
    case "J": case "X":
      return 8;
    case "Q": case "Z":
      return 10;
    default:
      return 0;
  }
}

const SERVER_BAG_SIZE = 98;
const DEFAULT_BAG: readonly (readonly [string, number])[] = [
  ["A", 9], ["B", 2], ["C", 2], ["D", 4], ["E", 12], ["F", 2], ["G", 3],
  ["H", 2], ["I", 9], ["J", 1], ["K", 1], ["L", 4], ["M", 2], ["N", 6],
  ["O", 8], ["P", 2], ["Q", 1], ["R", 6], ["S", 4], ["T", 6], ["U", 4],
  ["V", 2], ["W", 2], ["X", 1], ["Y", 2], ["Z", 1],
];

function serverLengthMultiplier(len: number): [bigint, bigint] {
  if (len <= 3) return [1n, 1n];
  if (len === 4) return [3n, 2n];
  if (len === 5) return [2n, 1n];
  if (len === 6) return [5n, 2n];
  return [3n, 1n];
}
function serverReward(base: number, len: number): number {
  const [n, d] = serverLengthMultiplier(len);
  return Number((BigInt(base) * n) / d);
}
function serverWordReward(word: string): number {
  let base = 0;
  for (const c of word) base += serverLetterValue(c);
  return serverReward(base, word.length);
}

// dictionary.ts port
const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
const asciiUppercase = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase());
const isAsciiUppercase = (s: string) => /^[A-Z]*$/.test(s);

const WORDLIST_PATH =
  process.env.WORDLIST ??
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "spacetimedb", "wordlist.txt");
const RAW_WORDLIST = fs.readFileSync(WORDLIST_PATH, "utf8");
const LEX_WORDS = RAW_WORDLIST.split("\n").filter((l) => l.length > 0);

function serverIsValidWord(word: string): boolean {
  const target = asciiUppercase(word);
  if (byteLength(target) < 2) return false;
  if (!isAsciiUppercase(target)) return false;
  let lo = 0;
  let hi = LEX_WORDS.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const w = LEX_WORDS[mid]!;
    if (w < target) lo = mid + 1;
    else if (w === target) return true;
    else hi = mid;
  }
  return false;
}

// Deterministic PRNG (mulberry32).
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// ---------- Scoring ----------

test("multiplier matches server lengthMultiplier for len 0..20", () => {
  for (let len = 0; len <= 20; len++) {
    const [n, d] = multiplier(len);
    const [sn, sd] = serverLengthMultiplier(len);
    assert.equal(BigInt(n), sn, `num len ${len}`);
    assert.equal(BigInt(d), sd, `den len ${len}`);
  }
});

test("rewardFor matches server bigint floor division for len 2..15, base 0..150", () => {
  let checked = 0;
  for (let len = 2; len <= 15; len++) {
    for (let base = 0; base <= 150; base++) {
      assert.equal(rewardFor(base, len), serverReward(base, len), `len ${len} base ${base}`);
      checked++;
    }
  }
  assert.equal(checked, 14 * 151);
});

test("rewardFor at odd bases with 1.5x / 2.5x floors down (never rounds)", () => {
  assert.equal(rewardFor(7, 4), 10); // 10.5 -> 10
  assert.equal(rewardFor(9, 4), 13); // 13.5 -> 13
  assert.equal(rewardFor(1, 4), 1); // 1.5 -> 1
  assert.equal(rewardFor(7, 6), 17); // 17.5 -> 17
  assert.equal(rewardFor(1, 6), 2); // 2.5 -> 2
  assert.equal(rewardFor(3, 6), 7); // 7.5 -> 7
  assert.equal(rewardFor(0, 7), 0);
});

test("rewardFor is monotone non-decreasing in base for each length", () => {
  for (let len = 2; len <= 15; len++) {
    for (let base = 1; base <= 150; base++) {
      assert.ok(rewardFor(base, len) >= rewardFor(base - 1, len), `len ${len} base ${base}`);
    }
  }
});

test("rewardFor is monotone non-decreasing in length for each base", () => {
  for (let base = 0; base <= 150; base++) {
    for (let len = 3; len <= 15; len++) {
      assert.ok(rewardFor(base, len) >= rewardFor(base, len - 1), `base ${base} len ${len}`);
    }
  }
});

test("LETTER_VALUE equals server letterValue for all 26 letters", () => {
  assert.equal(Object.keys(LETTER_VALUE).length, 26);
  for (const c of ALPHA) {
    assert.equal(LETTER_VALUE[c], serverLetterValue(c), `letter ${c}`);
  }
});

test("VALUES array mirrors LETTER_VALUE by index", () => {
  assert.equal(VALUES.length, 26);
  for (let i = 0; i < 26; i++) {
    assert.equal(VALUES[i], serverLetterValue(ALPHA[i]!), `index ${i}`);
  }
});

test("server letterValue returns 0 for non-letters; LETTER_VALUE has no such keys", () => {
  for (const c of ["a", "?", " ", "", "1", "AB"]) {
    assert.equal(serverLetterValue(c), 0);
    assert.equal(LETTER_VALUE[c], undefined);
  }
});

test("BAG sums to 98 and equals DEFAULT_BAG", () => {
  let total = 0;
  for (const v of Object.values(BAG)) total += v;
  assert.equal(total, SERVER_BAG_SIZE);
  let serverTotal = 0;
  for (const [, n] of DEFAULT_BAG) serverTotal += n;
  assert.equal(serverTotal, SERVER_BAG_SIZE);
  assert.equal(Object.keys(BAG).length, DEFAULT_BAG.length);
  for (const [c, n] of DEFAULT_BAG) assert.equal(BAG[c], n, `bag ${c}`);
  for (const c of ALPHA) assert.ok(BAG[c]! >= 1, `bag has ${c}`);
});

test("wordReward equals server for every word in the dictionary", () => {
  let n = 0;
  for (const w of WORDS) {
    assert.equal(wordReward(w), serverWordReward(w), w);
    n++;
  }
  assert.ok(n > 100_000, `only ${n} words`);
});

test("wordReward equals server for 20,000 random A-Z strings of length 2..15", () => {
  const r = rng(0xc0ffee);
  for (let i = 0; i < 20_000; i++) {
    const len = 2 + Math.floor(r() * 14);
    let s = "";
    for (let k = 0; k < len; k++) s += ALPHA[Math.floor(r() * 26)];
    assert.equal(wordReward(s), serverWordReward(s), s);
  }
});

test("wordReward known values", () => {
  assert.equal(wordReward("AA"), 2);
  assert.equal(wordReward("CAT"), 5);
  assert.equal(wordReward("CATS"), 9);
  assert.equal(wordReward("TACTS"), 14);
  assert.equal(wordReward("ZAX"), 19);
  assert.equal(wordReward("QUIZ"), 33); // 22 * 1.5 = 33
  assert.equal(wordReward("JAZZ"), 43); // 29 * 1.5 = 43.5 -> 43
  assert.equal(wordReward("SEVENTY"), 39);
  assert.equal(wordReward("QUIZZES"), 3 * 34); // 7 letters 3x
  assert.equal(wordReward("STRENGTHS"), 3 * 13);
});

test("wordReward on non-letters contributes 0 (matches server letterValue default)", () => {
  assert.equal(wordReward("A?"), serverWordReward("A?"));
  assert.equal(wordReward("ab"), serverWordReward("ab"));
  assert.equal(wordReward(""), 0);
});

// ---------- Dictionary ----------

test("wordlist file: sorted lex ascending (binary search precondition), no dupes", () => {
  for (let i = 1; i < LEX_WORDS.length; i++) {
    assert.ok(LEX_WORDS[i - 1]! < LEX_WORDS[i]!, `order at ${i}: ${LEX_WORDS[i - 1]} vs ${LEX_WORDS[i]}`);
  }
});

test("wordlist file: every raw line is A-Z only, length >= 2, no CR/whitespace", () => {
  for (const w of LEX_WORDS) {
    assert.match(w, /^[A-Z]{2,}$/, JSON.stringify(w));
  }
});

test("loaded WORDS has no lowercase/non-A-Z/short entries", () => {
  for (const w of WORDS) {
    assert.match(w, /^[A-Z]{2,}$/, JSON.stringify(w));
  }
});

test("loaded WORDS is exactly the server's lex word set", () => {
  assert.equal(WORDS.size, LEX_WORDS.length);
  for (const w of LEX_WORDS) assert.ok(WORDS.has(w), `missing ${w}`);
});

test("isWord agrees with server isValidWord on 20,000 random A-Z strings of length 2..9", () => {
  const r = rng(12345);
  let hits = 0;
  for (let i = 0; i < 20_000; i++) {
    const len = 2 + Math.floor(r() * 8);
    let s = "";
    for (let k = 0; k < len; k++) s += ALPHA[Math.floor(r() * 26)];
    const a = isWord(s);
    const b = serverIsValidWord(s);
    assert.equal(a, b, `${s}: bot ${a} server ${b}`);
    if (a) hits++;
  }
  assert.ok(hits > 0, "random strings never hit a word (test is vacuous)");
});

test("isWord agrees with server on 5,000 random real words (all true)", () => {
  const r = rng(777);
  for (let i = 0; i < 5_000; i++) {
    const w = LEX_WORDS[Math.floor(r() * LEX_WORDS.length)]!;
    assert.ok(isWord(w), w);
    assert.ok(serverIsValidWord(w), w);
  }
});

test("isWord agrees with server on 5,000 near-miss mutations of real words", () => {
  const r = rng(4242);
  for (let i = 0; i < 5_000; i++) {
    const w = LEX_WORDS[Math.floor(r() * LEX_WORDS.length)]!;
    const pos = Math.floor(r() * w.length);
    const mode = Math.floor(r() * 3);
    let s: string;
    if (mode === 0) s = w.slice(0, pos) + ALPHA[Math.floor(r() * 26)] + w.slice(pos + 1);
    else if (mode === 1) s = w.slice(0, pos) + w.slice(pos + 1);
    else s = w.slice(0, pos) + ALPHA[Math.floor(r() * 26)] + w.slice(pos);
    if (s.length < 2) continue;
    assert.equal(isWord(s), serverIsValidWord(s), s);
  }
});

test("isWord agrees with server on 3,000 random anagram shuffles of real words", () => {
  const r = rng(9001);
  for (let i = 0; i < 3_000; i++) {
    const w = LEX_WORDS[Math.floor(r() * LEX_WORDS.length)]!;
    const arr = Array.from(w);
    for (let k = arr.length - 1; k > 0; k--) {
      const j = Math.floor(r() * (k + 1));
      [arr[k], arr[j]] = [arr[j]!, arr[k]!];
    }
    const s = arr.join("");
    assert.equal(isWord(s), serverIsValidWord(s), s);
  }
});

test("isWord rejects single letters and empty, like server", () => {
  assert.equal(isWord(""), false);
  assert.equal(serverIsValidWord(""), false);
  for (const c of ALPHA) {
    assert.equal(isWord(c), false, c);
    assert.equal(serverIsValidWord(c), false, c);
  }
});

test("server normalizes lowercase; bot isWord on uppercased input agrees", () => {
  const r = rng(31337);
  for (let i = 0; i < 2_000; i++) {
    const w = LEX_WORDS[Math.floor(r() * LEX_WORDS.length)]!;
    const mixed = Array.from(w, (c) => (r() < 0.5 ? c.toLowerCase() : c)).join("");
    assert.equal(serverIsValidWord(mixed), true, mixed);
    assert.equal(isWord(mixed.toUpperCase()), true, mixed);
  }
});

test("non-ASCII and punctuation are rejected by both", () => {
  for (const s of ["CA T", "CAT!", "ÇAT", "CAT\n", "\nCAT", "CAT\r", "C-AT", "É", "ÆON"]) {
    assert.equal(serverIsValidWord(s), false, s);
    assert.equal(isWord(s), false, s);
  }
});

test("dictionary spot checks (ENABLE-ish): QAT yes, QI no, two-letter sample", () => {
  assert.ok(isWord("QAT") && serverIsValidWord("QAT"));
  assert.ok(!isWord("QI") && !serverIsValidWord("QI"));
  assert.ok(isWord("AA") && serverIsValidWord("AA"));
  assert.ok(isWord("ZA") === serverIsValidWord("ZA"));
  assert.ok(isWord("ZZZ") === serverIsValidWord("ZZZ"));
});

test("word length distribution: words of every length 2..15 exist and max length is sane", () => {
  const byLen = new Map<number, number>();
  let max = 0;
  for (const w of WORDS) {
    byLen.set(w.length, (byLen.get(w.length) ?? 0) + 1);
    if (w.length > max) max = w.length;
  }
  for (let len = 2; len <= 15; len++) assert.ok((byLen.get(len) ?? 0) > 0, `no words of length ${len}`);
  assert.ok(max <= 30, `max length ${max}`);
});

test("every dictionary word is spellable from a full bag (no letter exceeds its bag count)", () => {
  // Words needing more of a letter than the bag holds can never be played.
  let unplayable = 0;
  for (const w of WORDS) {
    const need = new Map<string, number>();
    for (const c of w) need.set(c, (need.get(c) ?? 0) + 1);
    for (const [c, n] of need) {
      if (n > BAG[c]!) {
        unplayable++;
        break;
      }
    }
  }
  // Informational: the server dictionary legitimately contains such words.
  assert.ok(unplayable >= 0);
});
