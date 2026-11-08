import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bestPartition,
  bestWord,
  canSpell,
  isWord,
  rewardFor,
  toCounts,
  wordReward,
} from "./words.js";
import { chooseWords, decideBid, type MatchView } from "./brain.js";
import { Ledger } from "./ledger.js";

// Server: totalReward = baseScore * num / denom with bigint floor division.
const server = (base: number, len: number) => {
  const [n, d] = len <= 3 ? [1n, 1n] : len === 4 ? [3n, 2n] : len === 5 ? [2n, 1n] : len === 6 ? [5n, 2n] : [3n, 1n];
  return Number((BigInt(base) * n) / d);
};

test("reward matches the server's integer math at every length edge", () => {
  for (let len = 2; len <= 12; len++)
    for (let base = 0; base <= 60; base++) assert.equal(rewardFor(base, len), server(base, len), `len ${len} base ${base}`);
  assert.equal(wordReward("CAT"), 5); // 3 letters 1x
  assert.equal(wordReward("CATS"), 9); // 4 letters: floor(6 * 1.5)
  assert.equal(wordReward("TACTS"), 14); // 5 letters 2x
  assert.equal(wordReward("ZAX"), 19);
  assert.equal(wordReward("SEVENTY"), 39); // 7 letters 3x
  assert.equal(wordReward("BEDS"), 10); // floor(7 * 1.5) = 10
});

test("dictionary is ENABLE (no QI) and validation is strict", () => {
  assert.ok(isWord("QAT"));
  assert.ok(!isWord("QI"));
  assert.ok(!isWord("A"));
  assert.ok(canSpell("CAT", toCounts("TACX")));
  assert.ok(!canSpell("TACT", toCounts("TACX")));
});

test("bestWord and bestPartition", () => {
  assert.equal(bestWord(toCounts("RETAINS"))!.len, 7);
  const p = bestPartition(toCounts("AEINRSTLDGOUX"));
  assert.ok(p.total >= 62, `got ${p.total}`);
  // Partition words are disjoint and spellable together.
  let r = toCounts("AEINRSTLDGOUX");
  for (const w of p.words) {
    assert.ok(isWord(w) && canSpell(w, r));
    for (const ch of w) r[ch.charCodeAt(0) - 65]!--;
  }
  assert.deepEqual(bestPartition(toCounts("Q")), { total: 0, words: [] });
});

test("engine is fast on big racks", () => {
  for (const r of ["AEIOUAEIOURSTLNDGBCM", "EEEEAAAIIIOORRSSTTNN", "BCDFGHJKLMNPQRSTVWXZ"]) {
    const t = performance.now();
    bestPartition(toCounts(r));
    assert.ok(performance.now() - t < 200, `${r} took ${performance.now() - t}ms`);
  }
});

const view = (rack: string, bagTotal: number, balance = 100): MatchView => ({
  bagTotal,
  auctionType: "Vickrey",
  myBalance: balance,
  myScore: 0,
  myRack: new Map(Object.entries([...rack].reduce((m: Record<string, number>, c) => ((m[c] = (m[c] ?? 0) + 1), m), {}))),
  unseen: new Map(),
  opponents: [],
  numPlayers: 6,
});

test("bids: never exceed balance, full balance on the final auction", () => {
  assert.equal(decideBid(view("AEST", 0, 37), "Z").bid, 37);
  assert.equal(decideBid(view("AEST", 30, 5), "Z").bid <= 5, true);
  assert.equal(decideBid(view("AEST", 30, 0), "Z").bid, 0);
  assert.ok(decideBid(view("RETAIN", 30), "S").bid > 0);
});

test("words: endgame cashes everything, bingos are played at once", () => {
  const end = chooseWords(view("RETAINSQ", 1));
  assert.ok(end.length >= 1);
  const mid = chooseWords(view("RETAINSX", 40));
  assert.equal(mid.length, 1);
  assert.ok(mid[0]!.length >= 7);
  assert.deepEqual(chooseWords(view("AEX", 40)), []);
});

test("ledger: unseen pool accounting", () => {
  const l = new Ledger(1n);
  l.onAuction(10n, "Z");
  l.onResult(10n, "Z", 2n, 5);
  l.onWord(1n, 2n, "ZAX"); // opponent 2 revealed hidden A and X
  const unseen = l.unseen(1n, new Map([["E", 2]]));
  assert.equal(unseen.get("Z"), undefined);
  assert.equal(unseen.get("X"), undefined);
  assert.equal(unseen.get("A"), 8);
  assert.equal(unseen.get("E"), 10);
});
