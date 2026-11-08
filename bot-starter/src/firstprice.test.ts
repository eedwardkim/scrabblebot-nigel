// FirstPrice auction checks for src/brain.ts: hand tests of decideBid and
// seeded sim tables (FirstPrice vs Vickrey) against jittered copies of the
// brain and against sim/rival.ts.
// Run: node --import tsx --test src/firstprice.test.ts
// Env: FP_MATCHES=<n> scales the sim tables (default sized to finish < 60 s).

import assert from "node:assert/strict";
import { test } from "node:test";
import * as brain from "./brain.js";
import { DEFAULT_PARAMS, decideBid, type MatchView, type Params } from "./brain.js";
import { runMatch, mulberry32, type PlayerSpec, type AuctionType, type Rng } from "../sim/engine.js";
import { RIVAL, rivalParams } from "../sim/rival.js";

const N_RIVAL = Number(process.env.FP_MATCHES ?? 120);
const N_SELF = Math.max(10, Math.round(N_RIVAL / 4));

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
const unseenFull = () => {
  const m = new Map<string, number>();
  const counts = "9 2 2 4 12 2 3 2 9 1 1 4 2 6 8 2 1 6 4 6 4 2 2 1 2 1".split(" ").map(Number);
  counts.forEach((c, i) => m.set(String.fromCharCode(65 + i), c));
  return m;
};
function view(over: Partial<MatchView> = {}): MatchView {
  return {
    bagTotal: 40,
    auctionType: "FirstPrice",
    myBalance: 100,
    myScore: 0,
    myRack: rack("TRAIN"),
    unseen: unseenFull(),
    opponents: [
      { balance: 100, score: 0 },
      { balance: 90, score: 0 },
      { balance: 80, score: 0 },
      { balance: 70, score: 0 },
      { balance: 60, score: 0 },
    ],
    numPlayers: 6,
    ...over,
  };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const RACKS = ["TRAIN", "QZXJK", "AEIOU", "SETRLN", "", "BCDFG", "EEEEE", "STARE", "QAT", "RSTLNEAIO"];

// ---------- hand tests ----------

test("FirstPrice: bid is an integer within [0, balance] for every letter/rack/balance", () => {
  for (const bal of [0, 1, 2, 5, 13, 50, 100, 250]) {
    for (const r of RACKS) {
      for (const L of LETTERS) {
        for (const bagTotal of [0, 1, 2, 4, 10, 30, 67]) {
          const v = view({ myBalance: bal, myRack: rack(r), bagTotal });
          const { bid } = decideBid(v, L);
          assert.ok(Number.isInteger(bid), `bid not integer: ${bid} (${L}, ${r}, bal ${bal}, bag ${bagTotal})`);
          assert.ok(bid >= 0 && bid <= bal, `bid ${bid} outside [0,${bal}] (${L}, ${r}, bag ${bagTotal})`);
        }
      }
    }
  }
});

test("FirstPrice: shaded bid never exceeds the Vickrey bid for the same view", () => {
  let shadedSomewhere = 0;
  for (const bal of [5, 20, 50, 100, 180]) {
    for (const r of RACKS) {
      for (const L of LETTERS) {
        for (const bagTotal of [1, 3, 6, 12, 30, 60]) {
          for (const avgPaid of [undefined, 3, 12, 30]) {
            const fp = decideBid(view({ myBalance: bal, myRack: rack(r), bagTotal, avgPaid }), L);
            const vk = decideBid(view({ myBalance: bal, myRack: rack(r), bagTotal, avgPaid, auctionType: "Vickrey" }), L);
            assert.ok(fp.bid <= vk.bid, `FP bid ${fp.bid} > Vickrey bid ${vk.bid} (${L}, ${r}, bal ${bal}, bag ${bagTotal}, avgPaid ${avgPaid})`);
            assert.equal(fp.value, vk.value, "value should not depend on auction type");
            if (fp.bid < vk.bid) shadedSomewhere++;
          }
        }
      }
    }
  }
  assert.ok(shadedSomewhere > 0, "FirstPrice never shaded below Vickrey anywhere");
});

test("FirstPrice: with every rival at balance 0 the bid is at most 1 (mid-game)", () => {
  const zero = Array.from({ length: 5 }, () => ({ balance: 0, score: 0 }));
  for (const r of RACKS) {
    for (const L of LETTERS) {
      for (const bagTotal of [8, 20, 40]) {
        const { bid, value } = decideBid(view({ myRack: rack(r), opponents: zero, bagTotal }), L);
        assert.ok(bid <= 1, `bid ${bid} with broke rivals (${L}, ${r}, value ${value.toFixed(2)})`);
        if (value > 0) assert.equal(bid, 1, `expected a 1-coin bid to take a free letter (${L}, ${r})`);
      }
    }
  }
});

test("FirstPrice: never bids above the richest rival + 1 mid-game", () => {
  for (const maxRival of [0, 1, 3, 7, 15, 40]) {
    const opps = [maxRival, Math.floor(maxRival / 2), 0, 0, 0].map((b) => ({ balance: b, score: 0 }));
    for (const r of RACKS) {
      for (const L of LETTERS) {
        const { bid } = decideBid(view({ myRack: rack(r), opponents: opps, bagTotal: 30 }), L);
        assert.ok(bid <= maxRival + 1, `bid ${bid} > maxRival+1 (${maxRival}) for ${L}/${r}`);
      }
    }
  }
});

test("FirstPrice: single opponent (sorted[1] undefined) is handled, bid in range", () => {
  for (const L of LETTERS) {
    const { bid } = decideBid(view({ opponents: [{ balance: 50, score: 0 }], numPlayers: 2 }), L);
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= 51, `bid ${bid}`);
  }
  const { bid } = decideBid(view({ opponents: [], numPlayers: 1 }), "E");
  assert.ok(bid <= 1, `no opponents: bid ${bid} should be <= 1`);
});

test("FirstPrice: last auction (bagTotal 0) bids the whole balance regardless of rivals", () => {
  for (const bal of [1, 7, 55]) {
    const { bid, value } = decideBid(view({ myBalance: bal, bagTotal: 0, opponents: [{ balance: 0, score: 0 }] }), "Z");
    assert.equal(bid, bal);
    assert.equal(value, 0);
  }
});

test("FirstPrice: zero balance -> bid 0; fractional/negative balance is floored safely", () => {
  assert.equal(decideBid(view({ myBalance: 0 }), "E").bid, 0);
  assert.equal(decideBid(view({ myBalance: -5 }), "E").bid, 0);
  const b = decideBid(view({ myBalance: 10.9 }), "E").bid;
  assert.ok(Number.isInteger(b) && b <= 10);
});

test("FirstPrice: bid is monotone non-decreasing in avgPaid for a fixed view", () => {
  for (const L of ["E", "S", "Q", "Z", "T"]) {
    let prev = -1;
    for (const avgPaid of [1, 2, 4, 8, 12, 16, 24, 32]) {
      const { bid } = decideBid(view({ avgPaid, myBalance: 100 }), L);
      assert.ok(bid >= prev, `${L}: bid fell from ${prev} to ${bid} as avgPaid rose to ${avgPaid}`);
      prev = bid;
    }
  }
});

test("FirstPrice: bid does not rise when rivals get poorer", () => {
  for (const L of ["E", "S", "Q", "A", "R"]) {
    let prev = Infinity;
    for (const rich of [200, 100, 60, 30, 15, 8, 3, 1, 0]) {
      const opps = Array.from({ length: 5 }, () => ({ balance: rich, score: 0 }));
      const { bid } = decideBid(view({ opponents: opps }), L);
      assert.ok(bid <= prev, `${L}: bid rose from ${prev} to ${bid} when rivals dropped to ${rich}`);
      prev = bid;
    }
  }
});

test("FirstPrice: mid-game bid is at most maxFrac of balance", () => {
  for (const bal of [10, 40, 100, 300]) {
    for (const L of LETTERS) {
      for (const r of RACKS) {
        const { bid } = decideBid(view({ myBalance: bal, myRack: rack(r), bagTotal: 30 }), L);
        assert.ok(bid <= Math.floor(bal * DEFAULT_PARAMS.maxFrac!) + 1, `bid ${bid} > maxFrac*bal (${bal}) for ${L}/${r}`);
      }
    }
  }
});

test("FirstPrice: params are honoured (fpFrac=0 shades harder than fpFrac=1 or equal)", () => {
  const lo: Params = { ...DEFAULT_PARAMS, fpFrac: 0 };
  const hi: Params = { ...DEFAULT_PARAMS, fpFrac: 1 };
  for (const L of LETTERS) {
    const a = decideBid(view({ avgPaid: 2 }), L, lo).bid;
    const b = decideBid(view({ avgPaid: 2 }), L, hi).bid;
    assert.ok(a <= b, `${L}: fpFrac 0 bid ${a} > fpFrac 1 bid ${b}`);
  }
});

test("FirstPrice: decideBid is deterministic", () => {
  for (const L of LETTERS) {
    const a = decideBid(view(), L);
    const b = decideBid(view(), L);
    assert.deepEqual(a, b);
  }
});

// ---------- sim tables ----------

function jitter(p: Params, rng: Rng): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(p)) out[k] = k === "endgame" ? v : v * (0.8 + 0.4 * rng());
  return out;
}

interface TableStats {
  matches: number;
  places: number[]; // histogram index place-1
  meanPlace: number;
  meanLeftover: number;
  maxLeftover: number;
  wins: number;
  rejectedBids: number;
  overpays: { letter: string; paid: number; value: number; bagTotal: number }[];
  midPaid: number;
  midCount: number;
}

function runTable(kind: "self" | "rival", auctionType: AuctionType, n: number, seed: number): TableStats {
  const rng = mulberry32(seed);
  const st: TableStats = {
    matches: n, places: [0, 0, 0, 0, 0, 0], meanPlace: 0, meanLeftover: 0, maxLeftover: 0,
    wins: 0, rejectedBids: 0, overpays: [], midPaid: 0, midCount: 0,
  };
  let placeSum = 0;
  let leftSum = 0;
  for (let m = 0; m < n; m++) {
    const others: PlayerSpec[] =
      kind === "self"
        ? Array.from({ length: 5 }, () => ({ kind: "brain", label: "self-jit", params: jitter(DEFAULT_PARAMS, rng) }))
        : Array.from({ length: 5 }, (_, i) => ({ kind: "brain", label: "rival", module: RIVAL, params: rivalParams(rng, i) }));
    const players: PlayerSpec[] = [{ kind: "brain", label: "brain", params: DEFAULT_PARAMS }, ...others];
    // Track the brain's own bid value at each close via a wrapped module.
    let lastValue = 0;
    let lastBag = 0;
    const wrapped = {
      DEFAULT_PARAMS,
      chooseWords: brain.chooseWords,
      decideBid: (v: MatchView, L: string, p?: Params) => {
        const r = brain.decideBid(v, L, p);
        lastValue = r.value;
        lastBag = v.bagTotal;
        return r;
      },
    };
    players[0] = { kind: "brain", label: "brain", params: DEFAULT_PARAMS, module: wrapped };
    const res = runMatch(
      {
        players,
        auctionType,
        brain,
        onClose: (ev) => {
          if (ev.winner !== 0) return;
          // mid-game: more than 12 auctions left (outside the spend ramp)
          if (lastBag > 12) {
            st.midPaid += ev.paid;
            st.midCount++;
            if (auctionType === "FirstPrice" && ev.paid > lastValue * 3 + 1) {
              st.overpays.push({ letter: ev.letter, paid: ev.paid, value: lastValue, bagTotal: lastBag });
            }
          }
        },
      },
      rng,
    );
    const me = res.players[0]!;
    assert.equal(me.label, "brain");
    st.places[me.place - 1]!++;
    placeSum += me.place;
    leftSum += me.balance;
    st.maxLeftover = Math.max(st.maxLeftover, me.balance);
    if (me.place === 1) st.wins++;
    st.rejectedBids += me.rejectedBids;
  }
  st.meanPlace = placeSum / n;
  st.meanLeftover = leftSum / n;
  return st;
}

function report(name: string, s: TableStats) {
  console.log(
    `[${name}] matches=${s.matches} meanPlace=${s.meanPlace.toFixed(2)} wins=${s.wins} places=${JSON.stringify(s.places)} ` +
      `meanLeftover=${s.meanLeftover.toFixed(1)} maxLeftover=${s.maxLeftover} rejectedBids=${s.rejectedBids} ` +
      `midAvgPaid=${s.midCount ? (s.midPaid / s.midCount).toFixed(1) : "-"} overpays=${s.overpays.length}`,
  );
}

test(`sim vs RIVAL: FirstPrice (${N_RIVAL} matches) vs Vickrey, no rejected bids, small leftover`, () => {
  const fp = runTable("rival", "FirstPrice", N_RIVAL, 101);
  const vk = runTable("rival", "Vickrey", N_RIVAL, 101);
  report("rival/FirstPrice", fp);
  report("rival/Vickrey", vk);
  assert.equal(fp.rejectedBids, 0, "brain submitted an invalid bid in FirstPrice");
  assert.equal(vk.rejectedBids, 0, "brain submitted an invalid bid in Vickrey");
  // Brain bids everything on the last auction, so leftover should be tiny.
  assert.ok(fp.meanLeftover <= 5, `FirstPrice mean leftover ${fp.meanLeftover.toFixed(1)} > 5`);
  assert.ok(fp.maxLeftover <= 40, `FirstPrice max leftover ${fp.maxLeftover} > 40`);
  if (fp.overpays.length) console.log("overpays sample:", fp.overpays.slice(0, 8));
  assert.ok(
    fp.overpays.length <= Math.ceil(fp.midCount * 0.05),
    `brain paid > 3x its value on ${fp.overpays.length}/${fp.midCount} mid-game FirstPrice wins`,
  );
  // Should not be dramatically worse in FirstPrice than Vickrey.
  assert.ok(fp.meanPlace <= vk.meanPlace + 1.0, `FirstPrice meanPlace ${fp.meanPlace} much worse than Vickrey ${vk.meanPlace}`);
});

test(`sim vs 5 jittered selves: FirstPrice (${N_SELF} matches) vs Vickrey`, () => {
  const fp = runTable("self", "FirstPrice", N_SELF, 202);
  const vk = runTable("self", "Vickrey", N_SELF, 202);
  report("self/FirstPrice", fp);
  report("self/Vickrey", vk);
  assert.equal(fp.rejectedBids, 0);
  assert.equal(vk.rejectedBids, 0);
  assert.ok(fp.meanLeftover <= 5, `FirstPrice mean leftover ${fp.meanLeftover.toFixed(1)} > 5`);
  if (fp.overpays.length) console.log("overpays sample:", fp.overpays.slice(0, 8));
  assert.ok(
    fp.overpays.length <= Math.ceil(fp.midCount * 0.05),
    `brain paid > 3x its value on ${fp.overpays.length}/${fp.midCount} mid-game FirstPrice wins`,
  );
  // Against copies of itself the default should land mid-table or better on average.
  assert.ok(fp.meanPlace <= 4.0, `FirstPrice self-play meanPlace ${fp.meanPlace}`);
});

test("sim: FirstPrice winner pays exactly its own bid (engine cross-check via onClose)", () => {
  const rng = mulberry32(7);
  let closes = 0;
  const players: PlayerSpec[] = [
    { kind: "brain", label: "brain", params: DEFAULT_PARAMS },
    ...Array.from({ length: 5 }, (_, i): PlayerSpec => ({ kind: "brain", label: "rival", module: RIVAL, params: rivalParams(rng, i) })),
  ];
  runMatch(
    {
      players,
      auctionType: "FirstPrice",
      brain,
      onClose: (ev) => {
        closes++;
        if (ev.winner === undefined) return;
        const top = Math.max(...ev.bids.map((b) => b.amount));
        assert.equal(ev.paid, top, `paid ${ev.paid} != top bid ${top} on ${ev.letter}`);
        const w = ev.bids.find((b) => b.who === ev.winner)!;
        assert.equal(w.amount, top);
      },
    },
    rng,
  );
  assert.equal(closes, 98 - 5 * 6);
});
