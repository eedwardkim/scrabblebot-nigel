// Fuzz invariants for src/brain.ts decideBid/chooseWords.
// Run: node --import tsx --test src/brain-fuzz.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { decideBid, chooseWords, letterValue, type MatchView } from "./brain.js";
import { isWord, BAG } from "./words.js";

const N = Number(process.env.FUZZ_N ?? 20000);

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0xC0FFEE);
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: T[]): T => xs[int(0, xs.length - 1)]!;
const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
const BAG_LETTERS: string[] = [];
for (const [l, n] of Object.entries(BAG)) for (let i = 0; i < n; i++) BAG_LETTERS.push(l);

function rackOf(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
}
function randomRack(size: number, weighted: boolean): Map<string, number> {
  let s = "";
  for (let i = 0; i < size; i++) s += weighted ? pick(BAG_LETTERS) : pick(LETTERS);
  return rackOf(s);
}
function randomUnseen(): Map<string, number> {
  const kind = int(0, 3);
  if (kind === 0) return new Map();
  if (kind === 1) return randomRack(int(1, 4), true);
  if (kind === 2) return new Map(Object.entries(BAG));
  // partial bag
  const m = new Map<string, number>();
  for (const [l, n] of Object.entries(BAG)) {
    const k = int(0, n);
    if (k > 0) m.set(l, k);
  }
  return m;
}
function randomBalance(): number {
  const k = int(0, 9);
  if (k === 0) return 0;
  if (k === 1) return 1;
  if (k === 2) return rnd() * 400; // fractional
  return int(0, 400);
}
function randomView(): MatchView {
  const nOpp = int(0, 5);
  const opponents = Array.from({ length: nOpp }, () => ({
    balance: int(0, 2) === 0 ? rnd() * 400 : int(0, 400),
    score: int(0, 300),
  }));
  return {
    bagTotal: int(0, 70),
    auctionType: rnd() < 0.5 ? "Vickrey" : "FirstPrice",
    myBalance: randomBalance(),
    myScore: int(0, 300),
    myRack: randomRack(int(0, 18), rnd() < 0.7),
    unseen: randomUnseen(),
    opponents,
    numPlayers: nOpp + 1,
    avgPaid: rnd() < 0.3 ? undefined : int(1, 60),
  };
}

function spellableTogether(words: string[], rack: Map<string, number>): boolean {
  const r = new Map(rack);
  for (const w of words) {
    for (const c of w) {
      const n = r.get(c) ?? 0;
      if (n <= 0) return false;
      r.set(c, n - 1);
    }
  }
  return true;
}
function pct(xs: number[], q: number): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}
function describe(v: MatchView, letter?: string): string {
  return JSON.stringify({
    letter,
    bagTotal: v.bagTotal,
    auctionType: v.auctionType,
    myBalance: v.myBalance,
    rack: [...v.myRack].map(([l, n]) => l.repeat(n)).join(""),
    unseen: [...v.unseen].map(([l, n]) => l + n).join(" "),
    opponents: v.opponents.map((o) => o.balance),
    avgPaid: v.avgPaid,
  });
}

const bidTimes: number[] = [];
const wordTimes: number[] = [];

test(`fuzz ${N} random views: decideBid invariants`, () => {
  const failures: string[] = [];
  for (let i = 0; i < N; i++) {
    const v = randomView();
    const letter = LETTERS[i % 26]!;
    let res: { bid: number; value: number };
    const t0 = performance.now();
    try {
      res = decideBid(v, letter);
    } catch (e) {
      failures.push(`THROW ${String(e)} :: ${describe(v, letter)}`);
      continue;
    } finally {
      bidTimes.push(performance.now() - t0);
    }
    const bal = Math.floor(Math.max(0, v.myBalance));
    if (!Number.isSafeInteger(res.bid)) failures.push(`bid not safe int ${res.bid} :: ${describe(v, letter)}`);
    if (res.bid < 0 || res.bid > bal) failures.push(`bid ${res.bid} out of [0,${bal}] :: ${describe(v, letter)}`);
    if (v.bagTotal === 0 && bal > 0 && res.bid !== bal)
      failures.push(`last auction bid ${res.bid} != balance ${bal} :: ${describe(v, letter)}`);
    if (!Number.isFinite(res.value) || res.value < 0)
      failures.push(`value ${res.value} not finite/non-negative :: ${describe(v, letter)}`);
    if (failures.length > 20) break;
  }
  assert.deepEqual(failures, [], failures.slice(0, 20).join("\n"));
});

test(`fuzz ${N} random views: chooseWords invariants`, () => {
  const failures: string[] = [];
  for (let i = 0; i < N; i++) {
    const v = randomView();
    let words: string[];
    const t0 = performance.now();
    try {
      words = chooseWords(v);
    } catch (e) {
      failures.push(`THROW ${String(e)} :: ${describe(v)}`);
      continue;
    } finally {
      wordTimes.push(performance.now() - t0);
    }
    if (!Array.isArray(words)) {
      failures.push(`not array :: ${describe(v)}`);
      continue;
    }
    for (const w of words) {
      if (typeof w !== "string" || w.length < 2 || !/^[A-Z]+$/.test(w) || !isWord(w))
        failures.push(`non-dictionary word ${JSON.stringify(w)} :: ${describe(v)}`);
    }
    if (!spellableTogether(words, v.myRack))
      failures.push(`words ${words.join(",")} not spellable together from rack :: ${describe(v)}`);
    if (failures.length > 20) break;
  }
  assert.deepEqual(failures, [], failures.slice(0, 20).join("\n"));
});

test("endgame (bagTotal <= 2) with a playable word always cashes out", () => {
  const failures: string[] = [];
  for (let i = 0; i < 3000; i++) {
    const v = randomView();
    v.bagTotal = int(0, 2);
    v.myRack = randomRack(int(2, 12), true);
    const words = chooseWords(v);
    // Does the rack hold any word at all? Check via a relaxed view (bagTotal 0 => bestPartition).
    const hasWord = chooseWords({ ...v, bagTotal: 0 }).length > 0 || rackHasAnyWord(v.myRack);
    if (hasWord && words.length === 0) failures.push(`empty at endgame :: ${describe(v)}`);
    if (failures.length > 10) break;
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

// Brute 2-letter check: any pair of rack letters forming a word means a word exists.
function rackHasAnyWord(rack: Map<string, number>): boolean {
  const letters = [...rack].flatMap(([l, n]) => Array(n).fill(l) as string[]);
  for (let a = 0; a < letters.length; a++)
    for (let b = 0; b < letters.length; b++)
      if (a !== b && isWord(letters[a]! + letters[b]!)) return true;
  return false;
}

test("endgame: known-playable racks produce non-empty plays", () => {
  const racks = ["AT", "CATX", "QUIZ", "RETAINS", "ZZQXAT", "EEEEEEE", "AAAAAAAAAAAA", "OX", "SZ"];
  for (const r of racks) {
    for (const bag of [0, 1, 2]) {
      const v: MatchView = {
        bagTotal: bag,
        auctionType: "Vickrey",
        myBalance: 50,
        myScore: 0,
        myRack: rackOf(r),
        unseen: new Map(),
        opponents: [],
        numPlayers: 1,
      };
      const words = chooseWords(v);
      const playable = rackHasAnyWord(v.myRack);
      if (playable) assert.ok(words.length > 0, `rack ${r} bag ${bag} expected a play, got none`);
      assert.ok(spellableTogether(words, v.myRack), `rack ${r}: ${words.join(",")} not spellable`);
      for (const w of words) assert.ok(isWord(w), `rack ${r}: ${w} not a word`);
    }
  }
});

test("7+ letter word available at bagTotal 40 is played", () => {
  const racks = ["RETAINS", "RETAINSZQ", "RETAINSXJKV", "SATIREKQ", "ZZRETAINSQ", "RETAINSAEIOU", "GRANITESQ"];
  for (const r of racks) {
    for (const bal of [0, 1, 50, 400]) {
      const v: MatchView = {
        bagTotal: 40,
        auctionType: "FirstPrice",
        myBalance: bal,
        myScore: 0,
        myRack: rackOf(r),
        unseen: new Map(Object.entries(BAG)),
        opponents: [{ balance: 100, score: 0 }],
        numPlayers: 2,
      };
      const words = chooseWords(v);
      assert.ok(words.length >= 1, `rack ${r} bal ${bal}: expected a 7+ word, got none`);
      assert.ok(words.some((w) => w.length >= 7), `rack ${r}: no 7+ word in ${words.join(",")}`);
      assert.ok(spellableTogether(words, v.myRack), `rack ${r}: ${words.join(",")} not spellable`);
      for (const w of words) assert.ok(isWord(w), `rack ${r}: ${w} not a word`);
    }
  }
});

test("mid-game rich bot with short rack and no bingo plays nothing (keeps tiles)", () => {
  const v: MatchView = {
    bagTotal: 40,
    auctionType: "Vickrey",
    myBalance: 200,
    myScore: 0,
    myRack: rackOf("CAT"),
    unseen: new Map(Object.entries(BAG)),
    opponents: [],
    numPlayers: 1,
  };
  assert.deepEqual(chooseWords(v), []);
});

test("decideBid edge cases", () => {
  const base: MatchView = {
    bagTotal: 10,
    auctionType: "Vickrey",
    myBalance: 100,
    myScore: 0,
    myRack: rackOf("RETAIN"),
    unseen: new Map(Object.entries(BAG)),
    opponents: [{ balance: 100, score: 0 }],
    numPlayers: 2,
  };
  // balance 0 -> bid 0 always
  for (const bag of [0, 1, 5, 40]) {
    assert.deepEqual(decideBid({ ...base, bagTotal: bag, myBalance: 0 }, "S"), { bid: 0, value: 0 });
    assert.equal(decideBid({ ...base, bagTotal: bag, myBalance: 0.9 }, "S").bid, 0);
    assert.equal(decideBid({ ...base, bagTotal: bag, myBalance: -5 }, "S").bid, 0);
  }
  // balance 1: bid in {0,1}
  for (const bag of [0, 1, 2, 5, 40]) {
    const b = decideBid({ ...base, bagTotal: bag, myBalance: 1 }, "S").bid;
    assert.ok(b === 0 || b === 1, `bal 1 bag ${bag}: bid ${b}`);
  }
  // last auction: whole balance regardless of letter/type
  for (const t of ["Vickrey", "FirstPrice"] as const)
    for (const l of LETTERS)
      assert.equal(decideBid({ ...base, bagTotal: 0, auctionType: t, myBalance: 37.6 }, l).bid, 37);
  // NaN / Infinity balance must not produce a bad bid
  for (const bal of [NaN, Infinity, -Infinity]) {
    const r = decideBid({ ...base, myBalance: bal }, "S");
    assert.ok(Number.isSafeInteger(r.bid) && r.bid >= 0, `balance ${bal} -> bid ${r.bid}`);
  }
  // Non-letter input
  for (const l of ["", "a", "1", "?", "AB"]) {
    const r = decideBid(base, l);
    assert.ok(Number.isSafeInteger(r.bid) && r.bid >= 0 && r.bid <= 100, `letter ${JSON.stringify(l)} -> ${r.bid}`);
    assert.ok(Number.isFinite(r.value) && r.value >= 0);
  }
  // letterValue is 0 on the last auction, finite otherwise
  for (const l of LETTERS) {
    assert.equal(letterValue({ ...base, bagTotal: 0 }, l), 0);
    const v = letterValue(base, l);
    assert.ok(Number.isFinite(v) && v >= 0, `letterValue ${l} = ${v}`);
  }
  // FirstPrice: never above richest rival + 1
  for (let i = 0; i < 500; i++) {
    const v = randomView();
    v.auctionType = "FirstPrice";
    v.bagTotal = int(1, 70);
    if (v.opponents.length === 0) continue;
    const maxRival = Math.max(...v.opponents.map((o) => Math.floor(o.balance)));
    const b = decideBid(v, pick(LETTERS)).bid;
    assert.ok(b <= Math.max(0, maxRival + 1) || b <= Math.floor(v.myBalance), `FP bid ${b} > maxRival+1 ${maxRival + 1}`);
    assert.ok(b <= maxRival + 1, `FP bid ${b} exceeds maxRival+1 (${maxRival + 1}) :: ${describe(v)}`);
  }
});

test("timing report", () => {
  const report = (name: string, xs: number[]) =>
    `${name}: n=${xs.length} p50=${pct(xs, 0.5).toFixed(3)}ms p99=${pct(xs, 0.99).toFixed(3)}ms max=${Math.max(...xs).toFixed(3)}ms`;
  console.log(report("decideBid", bidTimes));
  console.log(report("chooseWords", wordTimes));
  assert.ok(pct(bidTimes, 0.99) < 200, "decideBid p99 >= 200ms");
  assert.ok(pct(wordTimes, 0.99) < 200, "chooseWords p99 >= 200ms");
});
