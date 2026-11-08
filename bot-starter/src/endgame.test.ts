// Endgame behaviour of src/brain.ts: hand-made views plus end-to-end sim
// matches (selfmix and live tables, built like sim/run.ts does).
// Run: node --import tsx --test src/endgame.test.ts
// ENDGAME_MATCHES=<n> sets matches per table (default small so the suite
// stays under a minute; the full 400-match sweep is run out of band).

import assert from "node:assert/strict";
import { test } from "node:test";
import * as brain from "./brain.js";
import { DEFAULT_PARAMS, type MatchView, type Params } from "./brain.js";
import { bestPartition, canSpell, isWord, subtractWord, toCounts, wordReward } from "./words.js";
import { mulberry32, randInt, runMatch, type PlayerSpec, type Rng } from "../sim/engine.js";
import { RIVAL, rivalParams } from "../sim/rival.js";
import type { BrainModule } from "../sim/types.js";

const MATCHES = Number(process.env.ENDGAME_MATCHES ?? 10);

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
const unseenAll = () => {
  const m = new Map<string, number>();
  for (const [l, n] of Object.entries({ A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1 })) m.set(l, n);
  return m;
};
function view(partial: Partial<MatchView> & { myRack: Map<string, number> }): MatchView {
  return {
    bagTotal: 10,
    auctionType: "Vickrey",
    myBalance: 50,
    myScore: 0,
    unseen: unseenAll(),
    opponents: [
      { balance: 40, score: 10 },
      { balance: 30, score: 20 },
      { balance: 20, score: 5 },
      { balance: 60, score: 0 },
      { balance: 10, score: 30 },
    ],
    numPlayers: 6,
    avgPaid: 8,
    ...partial,
  };
}
function playable(words: string[], r: Map<string, number>): number {
  let c = toCounts(r);
  let total = 0;
  for (const w of words) {
    assert.ok(isWord(w), `${w} is not a word`);
    assert.ok(canSpell(w, c), `${w} not spellable from rack`);
    c = subtractWord(c, w);
    total += wordReward(w);
  }
  return total;
}

// ---------- hand-made views ----------

test("final auction (bagTotal 0): bid is the whole balance", () => {
  for (const bal of [1, 7, 33, 100, 250]) {
    const v = view({ bagTotal: 0, myBalance: bal, myRack: rack("QZXJ") });
    assert.equal(brain.decideBid(v, "E").bid, bal);
  }
});

test("final auction: whole balance even when the balance is fractional", () => {
  const v = view({ bagTotal: 0, myBalance: 33.7, myRack: rack("AB") });
  const { bid } = brain.decideBid(v, "E");
  assert.ok(Number.isInteger(bid));
  assert.equal(bid, 33);
});

test("final auction: balance 0 bids 0 without throwing", () => {
  const v = view({ bagTotal: 0, myBalance: 0, myRack: rack("AB") });
  assert.equal(brain.decideBid(v, "E").bid, 0);
});

test("final auction under FirstPrice still bids the whole balance", () => {
  const v = view({ bagTotal: 0, auctionType: "FirstPrice", myBalance: 77, myRack: rack("RETAIN") });
  assert.equal(brain.decideBid(v, "S").bid, 77);
});

test("final auction: chooseWords still cashes the whole rack", () => {
  const r = rack("RETAINSDOG");
  const v = view({ bagTotal: 0, myRack: r });
  const words = brain.chooseWords(v);
  assert.ok(words.length > 0);
  const total = playable(words, r);
  assert.equal(total, bestPartition(toCounts(r)).total, "chooseWords should equal the best partition");
});

test("final auction: no words on the rack -> empty list, no crash", () => {
  assert.deepEqual(brain.chooseWords(view({ bagTotal: 0, myRack: rack("QZXJV") })), []);
  assert.deepEqual(brain.chooseWords(view({ bagTotal: 0, myRack: rack("Q") })), []);
  assert.deepEqual(brain.chooseWords(view({ bagTotal: 0, myRack: new Map() })), []);
});

test("second-to-last (bagTotal 1): a letter completing a 7-letter word gets the full balance", () => {
  const cases: [string, string][] = [
    ["RETAIN", "S"], // RETAINS / RETINAS
    ["ETAOIN", "S"], // ATONIES
    ["QUIET", "S"], // QUIETS (6) -- still a word gain
    ["TRAINE", "D"], // TRAINED / DETRAIN
  ];
  for (const [r, l] of cases) {
    for (const bal of [5, 40, 100]) {
      const v = view({ bagTotal: 1, myBalance: bal, myRack: rack(r) });
      const res = brain.decideBid(v, l);
      assert.ok(res.value > 0, `${r}+${l} should have value`);
      assert.equal(res.bid, bal, `${r}+${l} bal ${bal}: bid ${res.bid}`);
    }
  }
});

test("second-to-last: a letter that adds nothing is not bought for nothing", () => {
  // Rack with no words even after adding the letter: value 0 => bid 0.
  const v = view({ bagTotal: 1, myBalance: 50, myRack: rack("Q") });
  const res = brain.decideBid(v, "Z");
  assert.equal(res.value, 0);
  assert.equal(res.bid, 0);
});

test("second-to-last: bid never exceeds balance, is an integer", () => {
  for (const [r, l] of [["RETAIN", "S"], ["AEIOU", "Q"], ["", "E"], ["SSSS", "S"]] as [string, string][]) {
    for (const bal of [0, 1, 3, 99.9]) {
      const res = brain.decideBid(view({ bagTotal: 1, myBalance: bal, myRack: rack(r) }), l);
      assert.ok(Number.isInteger(res.bid));
      assert.ok(res.bid >= 0 && res.bid <= Math.floor(bal), `${r}+${l} bal ${bal}: ${res.bid}`);
    }
  }
});

test("second-to-last under FirstPrice: never above the richest rival + 1", () => {
  const v = view({
    bagTotal: 1,
    auctionType: "FirstPrice",
    myBalance: 100,
    myRack: rack("RETAIN"),
    opponents: [
      { balance: 12, score: 0 },
      { balance: 8, score: 0 },
    ],
  });
  const res = brain.decideBid(v, "S");
  assert.ok(res.bid >= 1 && res.bid <= 13, `bid ${res.bid}`);
});

test("bagTotal 2 (endgame): chooseWords cashes the best partition", () => {
  for (const r of ["RETAINSDOG", "AEIOUBCDFG", "QUIETZXW", "SSEEAARRTTNN", "CAT", "AB"]) {
    const m = rack(r);
    const words = brain.chooseWords(view({ bagTotal: 2, myRack: m }));
    const total = playable(words, m);
    assert.equal(total, bestPartition(toCounts(m)).total, `${r}: ${words.join(",")}`);
  }
});

test("bagTotal 2: leftover after cashing has no playable word", () => {
  for (const r of ["RETAINSDOG", "AEIOUBCDFG", "QUIETZXW", "SSEEAARRTTNN"]) {
    const m = rack(r);
    let c = toCounts(m);
    for (const w of brain.chooseWords(view({ bagTotal: 2, myRack: m }))) c = subtractWord(c, w);
    assert.equal(bestPartition(c).total, 0, `${r}: leftover still forms a word`);
  }
});

test("bagTotal 3 (one above endgame): does not cash a healthy rack", () => {
  // Rack with only short words and plenty of cash: hold.
  const v = view({ bagTotal: 3, myBalance: 60, myRack: rack("CATBO") });
  assert.deepEqual(brain.chooseWords(v), []);
});

test("late game (bagTotal <= sixLate) plays a 6-letter word", () => {
  const m = rack("QUIETSZ");
  const words = brain.chooseWords(view({ bagTotal: 8, myBalance: 60, myRack: m }));
  assert.ok(words.length === 1 && words[0]!.length >= 6, words.join(","));
  playable(words, m);
});

test("decideBid at the final auction ignores the letter entirely", () => {
  const v = view({ bagTotal: 0, myBalance: 42, myRack: rack("RETAIN") });
  for (const l of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") assert.equal(brain.decideBid(v, l).bid, 42);
});

test("endgame bids monotone in balance at bagTotal 1 and 0", () => {
  for (const bt of [0, 1]) {
    let prev = -1;
    for (const bal of [1, 2, 5, 10, 20, 50, 100, 200]) {
      const b = brain.decideBid(view({ bagTotal: bt, myBalance: bal, myRack: rack("RETAIN") }), "S").bid;
      assert.ok(b >= prev, `bagTotal ${bt}: bid dropped from ${prev} to ${b} at balance ${bal}`);
      prev = b;
    }
  }
});

// ---------- end-to-end sim ----------

interface Trace {
  finalRack?: Map<string, number>;
  finalBid?: number;
  finalBal?: number;
  bidsLate: { bagTotal: number; bid: number; bal: number; value: number }[];
}
function tracing(t: Trace): BrainModule {
  return {
    DEFAULT_PARAMS,
    chooseWords: (v, p) => brain.chooseWords(v, p),
    decideBid: (v, l, p) => {
      const r = brain.decideBid(v, l, p);
      if (v.bagTotal <= 2) t.bidsLate.push({ bagTotal: v.bagTotal, bid: r.bid, bal: Math.floor(v.myBalance), value: r.value });
      if (v.bagTotal === 0) {
        t.finalRack = v.myRack;
        t.finalBid = r.bid;
        t.finalBal = Math.floor(v.myBalance);
      }
      return r;
    },
  };
}
function jitter(p: Params, rng: Rng): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(p)) out[k] = k === "endgame" ? v : v * (0.8 + 0.4 * rng());
  return out;
}
function players(table: "selfmix" | "live", rng: Rng, mod: BrainModule): PlayerSpec[] {
  const me: PlayerSpec = { kind: "brain", label: "brain", params: DEFAULT_PARAMS, module: mod };
  if (table === "live")
    return [me, ...Array.from({ length: 5 }, (_, i): PlayerSpec => ({ kind: "brain", label: "rival", module: RIVAL, params: rivalParams(rng, i) }))];
  return [me, ...Array.from({ length: 5 }, (): PlayerSpec => ({ kind: "brain", label: "self-jit", module: brain as BrainModule, params: jitter(DEFAULT_PARAMS, rng) }))];
}

function hist(xs: number[], edges: number[]): string {
  const bins = new Array(edges.length + 1).fill(0);
  for (const x of xs) {
    let i = 0;
    while (i < edges.length && x > edges[i]!) i++;
    bins[i]++;
  }
  return bins
    .map((n, i) => `${i === 0 ? `<=${edges[0]}` : i === edges.length ? `>${edges[edges.length - 1]}` : `${edges[i - 1]! + 1}-${edges[i]}`}:${n}`)
    .join(" ");
}

for (const table of ["selfmix", "live"] as const) {
  for (const auction of ["Vickrey", "FirstPrice"] as const) {
    test(`${table}/${auction}: ${MATCHES} matches leave no playable tiles, bid all at the end`, () => {
      const rng = mulberry32(table === "live" ? 1001 : 2002);
      const leftoverVal: number[] = [];
      const leftoverTiles: number[] = [];
      const leftoverBal: number[] = [];
      const places: number[] = [];
      let fullFinal = 0;
      let finalSeen = 0;
      let rejB = 0;
      let rejW = 0;
      let zeroBidsLate = 0;
      let lateBids = 0;
      const lateValuePos: number[] = [];
      for (let m = 0; m < MATCHES; m++) {
        const t: Trace = { bidsLate: [] };
        const res = runMatch(
          { players: players(table, rng, tracing(t)), auctionType: auction, brain: brain as BrainModule },
          mulberry32(randInt(rng, 1, 1 << 30)),
        );
        const me = res.players[0]!;
        assert.equal(me.label, "brain");
        rejB += me.rejectedBids;
        rejW += me.rejectedWords;
        leftoverBal.push(me.balance);
        leftoverTiles.push(me.leftoverTiles);
        places.push(me.place);
        assert.ok(t.finalRack, "brain never saw the final auction");
        const lv = bestPartition(toCounts(t.finalRack!)).total;
        leftoverVal.push(lv);
        finalSeen++;
        if (t.finalBid === t.finalBal) fullFinal++;
        for (const b of t.bidsLate) {
          if (b.bagTotal === 0) continue;
          lateBids++;
          if (b.bid === 0) zeroBidsLate++;
          if (b.value > 0) lateValuePos.push(b.bid / Math.max(1, b.bal));
        }
      }
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      console.log(
        `[${table}/${auction}] n=${MATCHES} place=${mean(places).toFixed(2)} ` +
          `leftoverWordValue mean=${mean(leftoverVal).toFixed(2)} max=${Math.max(...leftoverVal)} nonzero=${leftoverVal.filter((x) => x > 0).length} | ` +
          `leftoverTiles mean=${mean(leftoverTiles).toFixed(2)} hist ${hist(leftoverTiles, [0, 2, 4, 6, 8])} | ` +
          `leftoverBalance mean=${mean(leftoverBal).toFixed(1)} hist ${hist(leftoverBal, [0, 5, 10, 20, 40])} | ` +
          `finalBid==balance ${fullFinal}/${finalSeen} | bagTotal1-2 bids: ${lateBids}, zero=${zeroBidsLate}, bid/bal when value>0 mean=${mean(lateValuePos).toFixed(2)} | rejB=${rejB} rejW=${rejW}`,
      );
      assert.equal(rejB, 0, "rejected bids");
      assert.equal(rejW, 0, "rejected words");
      assert.equal(fullFinal, finalSeen, "brain did not bid its whole balance at the final auction");
      assert.equal(leftoverVal.filter((x) => x > 0).length, 0, `playable tiles left on the rack in ${leftoverVal.filter((x) => x > 0).length} matches`);
    });
  }
}
