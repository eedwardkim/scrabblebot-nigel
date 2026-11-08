// Simulator engine invariants (sim/engine.ts), checked across many seeded
// matches with mixed tables: real brain (src/brain.ts), RIVAL (sim/rival.ts)
// as a second brain module, sim bots, the starter bot and idle seats.
//   node --import tsx --test sim/sim-invariants.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mulberry32,
  runMatch,
  simDecideBid,
  type AuctionType,
  type MatchConfig,
  type MatchResult,
  type PlayerSpec,
  type Rng,
  type Strategy,
} from "./engine.js";
import type { BrainModule, MatchView } from "./types.js";
import { RIVAL, rivalParams } from "./rival.js";
import { BAG_COUNTS, isValidWord, wordReward } from "./words.js";
import * as BRAIN from "../src/brain.js";

const TOTAL_TILES = BAG_COUNTS.reduce((a, b) => a + b, 0);
const START_BAL = 100;
const RACK = 5;
const STRATS: Strategy[] = ["Cheapskate", "ValueBidder", "Aggressive"];

interface Probe {
  closes: number; // onClose events seen so far
  calls: { closes: number; bagTotal: number; balance: number; kind: "bid" | "words" }[];
  bidsSeen: { letter: string; bid: number; balance: number }[];
}

// Wrap a brain module so each call records when it happened (relative to
// auction closes) and what the view said.
function probed(mod: BrainModule, probe: Probe): BrainModule {
  return {
    DEFAULT_PARAMS: mod.DEFAULT_PARAMS,
    decideBid(view: MatchView, letter: string, params?) {
      probe.calls.push({ closes: probe.closes, bagTotal: view.bagTotal, balance: view.myBalance, kind: "bid" });
      const r = mod.decideBid(view, letter, params);
      probe.bidsSeen.push({ letter, bid: r.bid, balance: view.myBalance });
      return r;
    },
    chooseWords(view: MatchView, params?) {
      probe.calls.push({ closes: probe.closes, bagTotal: view.bagTotal, balance: view.myBalance, kind: "words" });
      return mod.chooseWords(view, params);
    },
  };
}

interface CloseEv {
  letter: string;
  bids: { who: number; amount: number }[];
  winner?: number;
  paid: number;
}

interface Run {
  config: MatchConfig;
  res: MatchResult;
  closes: CloseEv[];
  probes: Map<number, Probe>; // seat -> probe (brain seats only)
}

function buildTable(rng: Rng, n: number, shape: "mixed" | "brains" | "sims" | "idleheavy", brainProbe: Probe, rivalProbe: Probe): PlayerSpec[] {
  const players: PlayerSpec[] = [];
  const pb = probed(BRAIN as unknown as BrainModule, brainProbe);
  const pr = probed(RIVAL, rivalProbe);
  players.push({ kind: "brain", label: "nigel", module: pb, params: BRAIN.DEFAULT_PARAMS });
  if (n >= 2) players.push({ kind: "brain", label: "rival", module: pr, params: rivalParams(rng, 1) });
  for (let i = players.length; i < n; i++) {
    const r = rng();
    if (shape === "brains") {
      players.push({ kind: "brain", label: `rival${i}`, module: RIVAL, params: rivalParams(rng, i) });
    } else if (shape === "sims") {
      players.push({ kind: "sim", strategy: STRATS[i % 3]! });
    } else if (shape === "idleheavy") {
      players.push(r < 0.5 ? { kind: "idle" } : { kind: "starter" });
    } else if (r < 0.4) {
      players.push({ kind: "sim", strategy: STRATS[Math.floor(rng() * 3)]! });
    } else if (r < 0.6) {
      players.push({ kind: "starter" });
    } else if (r < 0.75) {
      players.push({ kind: "idle" });
    } else {
      players.push({ kind: "brain", label: `rival${i}`, module: RIVAL, params: rivalParams(rng, i) });
    }
  }
  // Rotate so the brain is not always seat 0.
  const rot = Math.floor(rng() * n);
  return players.slice(rot).concat(players.slice(0, rot));
}

function runOne(seed: number, n: number, auctionType: AuctionType, shape: Parameters<typeof buildTable>[2]): Run {
  const rng = mulberry32(seed);
  const brainProbe: Probe = { closes: 0, calls: [], bidsSeen: [] };
  const rivalProbe: Probe = { closes: 0, calls: [], bidsSeen: [] };
  const players = buildTable(rng, n, shape, brainProbe, rivalProbe);
  const closes: CloseEv[] = [];
  const config: MatchConfig = {
    players,
    auctionType,
    brain: BRAIN as unknown as BrainModule,
    onClose: (ev) => {
      closes.push({ letter: ev.letter, bids: ev.bids.map((b) => ({ ...b })), winner: ev.winner, paid: ev.paid });
      brainProbe.closes++;
      rivalProbe.closes++;
    },
  };
  const res = runMatch(config, rng);
  const probes = new Map<number, Probe>();
  players.forEach((p, i) => {
    if (p.kind === "brain" && p.label === "nigel") probes.set(i, brainProbe);
    if (p.kind === "brain" && p.label === "rival") probes.set(i, rivalProbe);
  });
  return { config, res, closes, probes };
}

function checkInvariants(run: Run, tag: string) {
  const { config, res, closes } = run;
  const n = config.players.length;
  const expectAuctions = TOTAL_TILES - RACK * n;

  // 1. exactly 98 - 5N auctions, one onClose per auction, auction type echoed
  assert.equal(res.auctions, expectAuctions, `${tag}: auctions`);
  assert.equal(closes.length, expectAuctions, `${tag}: onClose count`);
  assert.equal(res.auctionType, config.auctionType ?? "Vickrey", `${tag}: auctionType`);
  assert.equal(res.players.length, n, `${tag}: player count`);

  // 2. letters revealed match the bag distribution exactly (bag ends empty):
  //    dealt racks are hidden, so revealed + 5N == 98 and revealed <= bag counts
  const revealed = new Array<number>(26).fill(0);
  for (const c of closes) {
    assert.match(c.letter, /^[A-Z]$/, `${tag}: letter`);
    revealed[c.letter.charCodeAt(0) - 65]!++;
  }
  for (let i = 0; i < 26; i++) assert.ok(revealed[i]! <= BAG_COUNTS[i]!, `${tag}: revealed ${String.fromCharCode(65 + i)} exceeds bag`);

  // 3. per-close: bids positive integers, sorted desc, winner is top bidder,
  //    paid follows the auction rule, paid <= winning bid, no self-duplicates
  let awarded = 0;
  const paidByWinner = new Array<number>(n).fill(0);
  for (const [k, c] of closes.entries()) {
    const seen = new Set<number>();
    for (const b of c.bids) {
      assert.ok(Number.isInteger(b.amount) && b.amount > 0, `${tag}#${k}: bid amount ${b.amount}`);
      assert.ok(b.who >= 0 && b.who < n, `${tag}#${k}: bidder seat`);
      assert.ok(!seen.has(b.who), `${tag}#${k}: seat ${b.who} bid twice`);
      seen.add(b.who);
    }
    for (let i = 1; i < c.bids.length; i++) assert.ok(c.bids[i - 1]!.amount >= c.bids[i]!.amount, `${tag}#${k}: bids not sorted`);
    if (c.bids.length === 0) {
      assert.equal(c.winner, undefined, `${tag}#${k}: winner with no bids`);
      assert.equal(c.paid, 0, `${tag}#${k}: paid with no bids`);
      continue;
    }
    const top = c.bids[0]!;
    assert.equal(c.winner, top.who, `${tag}#${k}: winner is not top bidder`);
    assert.ok(c.paid <= top.amount, `${tag}#${k}: paid ${c.paid} > bid ${top.amount}`);
    assert.ok(c.paid >= 1, `${tag}#${k}: paid < 1 with a winner`);
    if (res.auctionType === "FirstPrice") {
      assert.equal(c.paid, top.amount, `${tag}#${k}: first-price paid`);
    } else if (c.bids.length >= 2) {
      assert.equal(c.paid, c.bids[1]!.amount, `${tag}#${k}: Vickrey paid != 2nd bid`);
    } else {
      assert.equal(c.paid, Math.min(1, top.amount), `${tag}#${k}: lone bidder pays min(1,bid)`);
    }
    awarded++;
    paidByWinner[top.who]! += c.paid;
  }

  // 4. per-player accounting
  let totalWon = 0;
  let totalSpent = 0;
  for (const [i, p] of res.players.entries()) {
    const spec = config.players[i]!;
    assert.equal(p.kind, spec.kind, `${tag}: kind seat ${i}`);
    assert.ok(p.balance >= 0, `${tag}: negative balance seat ${i} (${p.balance})`);
    assert.ok(Number.isInteger(p.balance), `${tag}: fractional balance seat ${i}`);
    assert.ok(Number.isInteger(p.score) && p.score >= 0, `${tag}: score seat ${i}`);
    // score == sum of word rewards; every word valid and >= 2 letters
    let rewardSum = 0;
    let wordLetters = 0;
    for (const w of p.words) {
      assert.match(w, /^[A-Z]{2,}$/, `${tag}: word ${w}`);
      assert.ok(isValidWord(w), `${tag}: invalid word ${w}`);
      rewardSum += wordReward(w);
      wordLetters += w.length;
    }
    assert.equal(p.score, rewardSum, `${tag}: score != reward sum seat ${i}`);
    assert.equal(p.wordsPlayed, p.words.length, `${tag}: wordsPlayed seat ${i}`);
    // tiles: dealt + won == leftover + letters played
    assert.equal(RACK + p.lettersWon, p.leftoverTiles + wordLetters, `${tag}: tile accounting seat ${i}`);
    // balance == 100 - spent + score
    assert.equal(p.balance, START_BAL - p.spent + p.score, `${tag}: balance identity seat ${i}`);
    // spent never exceeds the paid total of auctions this seat won
    assert.ok(p.spent <= paidByWinner[i]!, `${tag}: spent > paid seat ${i}`);
    // idle seats do nothing
    if (spec.kind === "idle") {
      assert.equal(p.lettersWon, 0, `${tag}: idle won`);
      assert.equal(p.spent, 0, `${tag}: idle spent`);
      assert.equal(p.score, 0, `${tag}: idle scored`);
      assert.equal(p.leftoverTiles, RACK, `${tag}: idle tiles`);
    }
    // brains: engine never rejected a word or bid from the real brain / rival
    if (spec.kind === "brain") {
      assert.equal(p.rejectedWords, 0, `${tag}: rejected words seat ${i} (${p.label})`);
      assert.equal(p.rejectedBids, 0, `${tag}: rejected bids seat ${i} (${p.label})`);
    } else {
      assert.equal(p.rejectedWords, 0, `${tag}: rejected words non-brain seat ${i}`);
      assert.equal(p.rejectedBids, 0, `${tag}: rejected bids non-brain seat ${i}`);
    }
    // place: 1 + number with strictly higher score
    const higher = res.players.filter((o) => o.score > p.score).length;
    assert.equal(p.place, 1 + higher, `${tag}: place seat ${i}`);
    totalWon += p.lettersWon;
    totalSpent += p.spent;
  }

  // 5. whole-table tile conservation: bag (0 at end) + racks + played letters
  //    + discarded (auctions with no award) == 98
  const racks = res.players.reduce((a, p) => a + p.leftoverTiles, 0);
  const played = res.players.reduce((a, p) => a + p.words.reduce((b, w) => b + w.length, 0), 0);
  const discarded = res.auctions - totalWon;
  assert.ok(discarded >= 0, `${tag}: more letters won than auctions`);
  assert.ok(totalWon <= awarded, `${tag}: won ${totalWon} > awarded ${awarded}`);
  assert.equal(0 + racks + played + discarded, TOTAL_TILES, `${tag}: tile conservation`);
  // money conservation: sum spent == sum of paid where the winner could pay
  assert.ok(totalSpent <= closes.reduce((a, c) => a + c.paid, 0), `${tag}: money conservation`);

  // 6. probes: nothing happens after the final close; views are sane
  for (const [seat, probe] of run.probes) {
    const p = res.players[seat]!;
    for (const call of probe.calls) {
      assert.ok(call.closes < res.auctions, `${tag}: ${p.label} called after final close`);
      assert.ok(call.balance >= 0, `${tag}: ${p.label} saw negative balance`);
      assert.ok(call.bagTotal >= 0 && call.bagTotal <= TOTAL_TILES - RACK * n - 1, `${tag}: ${p.label} bagTotal ${call.bagTotal}`);
      assert.equal(call.bagTotal, res.auctions - 1 - call.closes, `${tag}: ${p.label} bagTotal vs closes`);
    }
    // exactly one decideBid call per auction for each brain seat
    const bidCalls = probe.calls.filter((c) => c.kind === "bid").length;
    assert.equal(bidCalls, res.auctions, `${tag}: ${p.label} decideBid calls`);
    // the brain never bid more than its balance (engine would reject it)
    for (const b of probe.bidsSeen) {
      assert.ok(Number.isInteger(b.bid) && b.bid >= 0 && b.bid <= b.balance, `${tag}: ${p.label} bid ${b.bid} with balance ${b.balance} on ${b.letter}`);
    }
    // the last auction's bagTotal is 0 for the brain's view
    const last = probe.calls.filter((c) => c.kind === "bid").at(-1);
    assert.equal(last?.bagTotal, 0, `${tag}: ${p.label} final auction bagTotal`);
  }
}

// --- determinism ---------------------------------------------------------

test("same seed reproduces the same match", () => {
  const a = runOne(42, 6, "Vickrey", "mixed");
  const b = runOne(42, 6, "Vickrey", "mixed");
  assert.deepEqual(a.res, b.res);
  assert.deepEqual(a.closes, b.closes);
});

test("different seeds produce different matches", () => {
  const a = runOne(1, 6, "Vickrey", "mixed");
  const b = runOne(2, 6, "Vickrey", "mixed");
  assert.notDeepEqual(a.closes.map((c) => c.letter), b.closes.map((c) => c.letter));
});

// --- the 300-match sweep ---------------------------------------------------

const SWEEP: { n: number; auction: AuctionType; shape: Parameters<typeof buildTable>[2]; count: number; seed0: number }[] = [
  { n: 6, auction: "Vickrey", shape: "mixed", count: 90, seed0: 1000 },
  { n: 6, auction: "FirstPrice", shape: "mixed", count: 60, seed0: 2000 },
  { n: 6, auction: "Vickrey", shape: "brains", count: 30, seed0: 3000 },
  { n: 6, auction: "FirstPrice", shape: "sims", count: 20, seed0: 4000 },
  { n: 6, auction: "Vickrey", shape: "idleheavy", count: 20, seed0: 5000 },
  { n: 3, auction: "Vickrey", shape: "mixed", count: 20, seed0: 6000 },
  { n: 3, auction: "FirstPrice", shape: "mixed", count: 15, seed0: 7000 },
  { n: 2, auction: "Vickrey", shape: "mixed", count: 15, seed0: 8000 },
  { n: 2, auction: "FirstPrice", shape: "mixed", count: 10, seed0: 9000 },
  { n: 4, auction: "Vickrey", shape: "mixed", count: 10, seed0: 10000 },
  { n: 5, auction: "FirstPrice", shape: "mixed", count: 10, seed0: 11000 },
];

let total = 0;
for (const s of SWEEP) {
  test(`${s.count} x ${s.n}p ${s.auction} ${s.shape}: engine invariants hold`, () => {
    for (let m = 0; m < s.count; m++) {
      const seed = s.seed0 + m;
      const run = runOne(seed, s.n, s.auction, s.shape);
      checkInvariants(run, `seed=${seed} n=${s.n} ${s.auction} ${s.shape}`);
      total++;
    }
  });
}

test("sweep covered at least 300 matches", () => {
  assert.ok(total >= 300, `only ${total} matches`);
});

// --- targeted engine edge cases -------------------------------------------

test("6-player all-sim table: 68 auctions, every letter gets a bid, Vickrey prices", () => {
  const rng = mulberry32(7);
  const closes: CloseEv[] = [];
  const res = runMatch(
    {
      players: STRATS.concat(STRATS).map((strategy) => ({ kind: "sim", strategy })),
      onClose: (ev) => closes.push(ev),
    },
    rng,
  );
  assert.equal(res.auctions, 68);
  for (const c of closes) {
    assert.ok(c.bids.length >= 1, "sims always bid >= 1 while they have money");
    if (c.bids.length >= 2) assert.equal(c.paid, c.bids[1]!.amount);
  }
});

test("2 idle players: 88 auctions, nothing bought, all tiles discarded", () => {
  const res = runMatch({ players: [{ kind: "idle" }, { kind: "idle" }] }, mulberry32(3));
  assert.equal(res.auctions, 88);
  for (const p of res.players) {
    assert.equal(p.lettersWon, 0);
    assert.equal(p.balance, 100);
    assert.equal(p.leftoverTiles, 5);
    assert.equal(p.place, 1);
  }
});

test("lone bidder pays exactly 1 under Vickrey (constant-bid brain vs idle)", () => {
  const brain: BrainModule = {
    DEFAULT_PARAMS: {},
    decideBid: (v) => ({ bid: Math.min(7, v.myBalance), value: 0 }),
    chooseWords: () => [],
  };
  const closes: CloseEv[] = [];
  const res = runMatch(
    { players: [{ kind: "brain", label: "b", module: brain }, { kind: "idle" }], brain, onClose: (ev) => closes.push(ev) },
    mulberry32(11),
  );
  assert.equal(res.auctions, 88);
  for (const c of closes) {
    assert.equal(c.bids.length, 1);
    assert.equal(c.paid, 1);
  }
  const b = res.players[0]!;
  assert.equal(b.spent, 88);
  assert.equal(b.balance, 12);
  assert.equal(b.lettersWon, 88);
  assert.equal(b.leftoverTiles, 93);
});

test("lone bidder pays its own bid under FirstPrice", () => {
  const brain: BrainModule = {
    DEFAULT_PARAMS: {},
    decideBid: (v) => ({ bid: Math.min(3, v.myBalance), value: 0 }),
    chooseWords: () => [],
  };
  const closes: CloseEv[] = [];
  const res = runMatch(
    { players: [{ kind: "brain", label: "b", module: brain }, { kind: "idle" }], auctionType: "FirstPrice", brain, onClose: (ev) => closes.push(ev) },
    mulberry32(12),
  );
  // 100 / 3 = 33 full-price wins, then one bid of 1, then 0 (no bid).
  const won = closes.filter((c) => c.winner !== undefined).length;
  assert.equal(won, 34);
  assert.equal(res.players[0]!.balance, 0);
  assert.equal(res.players[0]!.spent, 100);
  for (const c of closes) if (c.winner !== undefined) assert.equal(c.paid, c.bids[0]!.amount);
});

test("brain bidding above its balance is rejected (counted, no bid placed)", () => {
  const brain: BrainModule = {
    DEFAULT_PARAMS: {},
    decideBid: (v) => ({ bid: v.myBalance + 1, value: 0 }),
    chooseWords: () => [],
  };
  const res = runMatch({ players: [{ kind: "brain", label: "b", module: brain }, { kind: "idle" }], brain }, mulberry32(5));
  assert.equal(res.players[0]!.rejectedBids, 88);
  assert.equal(res.players[0]!.lettersWon, 0);
  assert.equal(res.players[0]!.balance, 100);
});

test("brain fractional / NaN / negative bids are rejected", () => {
  for (const bad of [0.5, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const brain: BrainModule = { DEFAULT_PARAMS: {}, decideBid: () => ({ bid: bad, value: 0 }), chooseWords: () => [] };
    const res = runMatch({ players: [{ kind: "brain", label: "b", module: brain }, { kind: "idle" }], brain }, mulberry32(5));
    assert.equal(res.players[0]!.rejectedBids, 88, `bid ${bad}`);
  }
});

test("brain bid of 0 is neither a bid nor a rejection", () => {
  const brain: BrainModule = { DEFAULT_PARAMS: {}, decideBid: () => ({ bid: 0, value: 0 }), chooseWords: () => [] };
  const closes: CloseEv[] = [];
  const res = runMatch({ players: [{ kind: "brain", label: "b", module: brain }, { kind: "idle" }], brain, onClose: (ev) => closes.push(ev) }, mulberry32(5));
  assert.equal(res.players[0]!.rejectedBids, 0);
  assert.ok(closes.every((c) => c.bids.length === 0 && c.winner === undefined && c.paid === 0));
});

test("invalid / unplayable / lowercase words from a brain", () => {
  let calls = 0;
  const brain: BrainModule = {
    DEFAULT_PARAMS: {},
    decideBid: () => ({ bid: 0, value: 0 }),
    chooseWords: (v) => {
      calls++;
      if (calls > 1) return [];
      // "ZZZZZ" invalid; "QI" not in ENABLE; "A" too short; 123 not a string.
      return ["ZZZZZ", "QI", "A", 123 as unknown as string, "aa"];
    },
  };
  const res = runMatch({ players: [{ kind: "brain", label: "b", module: brain }, { kind: "idle" }], brain }, mulberry32(9));
  const p = res.players[0]!;
  // "aa" is upper-cased and valid only if the rack holds two A's; either way
  // the four bad entries are rejected.
  assert.ok(p.rejectedWords === 4 || p.rejectedWords === 5, `rejected ${p.rejectedWords}`);
  assert.equal(p.score, p.words.reduce((a, w) => a + wordReward(w), 0));
});

test("chooseWords is re-called until it returns nothing, and words come off the rack", () => {
  // Brain that plays any 2-letter word it can, one per call.
  const brain: BrainModule = {
    DEFAULT_PARAMS: {},
    decideBid: (v) => ({ bid: v.bagTotal === 0 ? v.myBalance : 1, value: 0 }),
    chooseWords: (v) => {
      const letters: string[] = [];
      for (const [c, k] of v.myRack) for (let i = 0; i < k; i++) letters.push(c);
      for (let i = 0; i < letters.length; i++)
        for (let j = 0; j < letters.length; j++) {
          if (i === j) continue;
          const w = letters[i]! + letters[j]!;
          if (isValidWord(w)) return [w];
        }
      return [];
    },
  };
  const res = runMatch({ players: [{ kind: "brain", label: "b", module: brain }, { kind: "sim", strategy: "Cheapskate" }], brain }, mulberry32(21));
  const p = res.players[0]!;
  assert.equal(p.rejectedWords, 0);
  assert.equal(RACK + p.lettersWon, p.leftoverTiles + p.words.reduce((a, w) => a + w.length, 0));
  assert.equal(p.balance, 100 - p.spent + p.score);
  assert.ok(p.words.length > 0);
});

test("simDecideBid matches the server formula and clamps to [0, balance]", () => {
  // E (idx 4, value 1, vowel)
  assert.equal(simDecideBid("Cheapskate", 4, 100, 0), 1); // max(0,1)=1 floor
  assert.equal(simDecideBid("ValueBidder", 4, 100, 0), 1);
  assert.equal(simDecideBid("Aggressive", 4, 100, 0), 5);
  assert.equal(simDecideBid("Aggressive", 4, 100, 2), 7);
  // Q (idx 16, value 10)
  assert.equal(simDecideBid("Cheapskate", 16, 100, -2), 7);
  assert.equal(simDecideBid("ValueBidder", 16, 100, 2), 12);
  assert.equal(simDecideBid("Aggressive", 16, 100, 0), 12);
  // clamps
  assert.equal(simDecideBid("Aggressive", 16, 3, 2), 3);
  assert.equal(simDecideBid("Aggressive", 16, 0, 2), 0);
  assert.equal(simDecideBid("Cheapskate", 4, 100, -2), 1); // min bid 1 while funded
});

test("startingRackSize / startingBalance overrides change the auction count", () => {
  const res = runMatch({ players: [{ kind: "idle" }, { kind: "idle" }, { kind: "idle" }], startingRackSize: 7, startingBalance: 50 }, mulberry32(2));
  assert.equal(res.auctions, 98 - 21);
  for (const p of res.players) {
    assert.equal(p.leftoverTiles, 7);
    assert.equal(p.balance, 50);
  }
});

test("brain player without a module and without config.brain throws", () => {
  assert.throws(() => runMatch({ players: [{ kind: "brain", label: "x" }] }, mulberry32(1)), /config.brain is required/);
});

test("real brain never bids its last auction below its full balance (RULES #4) when funded", () => {
  // Across a few matches, the final auction (bagTotal 0) bid should equal the balance.
  for (let m = 0; m < 10; m++) {
    const run = runOne(500 + m, 6, "Vickrey", "mixed");
    for (const [seat, probe] of run.probes) {
      if (run.res.players[seat]!.label !== "nigel") continue;
      const last = probe.bidsSeen.at(-1)!;
      if (last.balance > 0) assert.equal(last.bid, last.balance, `seed ${500 + m}: final bid ${last.bid} vs balance ${last.balance}`);
    }
  }
});
