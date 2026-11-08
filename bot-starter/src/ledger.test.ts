// Ledger checks: full scripted 6-bot matches fed in server order, idempotent
// duplicate events, reconnect replays in other orders, avgPaid windowing.
// Run with `node --import tsx --test src/ledger.test.ts`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger } from "./ledger.js";
import { BAG } from "./words.js";

// ---------- helpers ----------

const letters = Object.keys(BAG).sort();
const TOTAL = Object.values(BAG).reduce((a, b) => a + b, 0);

function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fullBag(): string[] {
  const out: string[] = [];
  for (const c of letters) for (let i = 0; i < BAG[c]!; i++) out.push(c);
  return out;
}

function shuffle<T>(xs: T[], rng: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const rackOf = (word: string) => {
  const r = new Map<string, number>();
  for (const c of word) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
const mapsEqual = (a: Map<string, number>, b: Map<string, number>) => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
};

function captureWarn<T>(fn: () => T): { value: T; warns: string[] } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  try {
    return { value: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

// ---------- scripted match ----------

type Ev =
  | { t: "auction"; id: bigint; letter: string }
  | { t: "result"; id: bigint; letter: string; winner?: bigint; paid: number }
  | { t: "word"; id: bigint; bot: bigint; word: string };

interface Snapshot {
  bagRemaining: number;
  oppUnrevealedStart: number; // true count of opponents' starting tiles not yet played
  myRack: Map<string, number>;
}

interface Script {
  events: Ev[];
  after: Snapshot[]; // after[i] = world state after events[i]
  starts: Map<bigint, string[]>;
}

const ME = 1n;
const BOTS = [1n, 2n, 3n, 4n, 5n, 6n];

// mode "clean": opponents play only starting tiles of letters they never won
// (so the ledger's inference P-W is exact); mode "random": anything goes.
// playOutAtEnd: once the bag is empty, every opponent plays all remaining tiles.
function scriptMatch(seed: number, opts: { mode: "clean" | "random"; playOutAtEnd?: boolean; noBidRate?: number }): Script {
  const rng = lcg(seed);
  const bag = shuffle(fullBag(), rng);
  const starts = new Map<bigint, string[]>();
  // per bot: held tiles split into start / won
  const startHeld = new Map<bigint, Map<string, number>>();
  const wonHeld = new Map<bigint, Map<string, number>>();
  const wonTotal = new Map<bigint, Map<string, number>>();
  for (const b of BOTS) {
    const s = bag.splice(0, 5);
    starts.set(b, s);
    startHeld.set(b, rackOf(s.join("")));
    wonHeld.set(b, new Map());
    wonTotal.set(b, new Map());
  }
  const events: Ev[] = [];
  const after: Snapshot[] = [];
  let nextId = 1000n;
  const inc = (m: Map<string, number>, c: string, d = 1) => {
    const v = (m.get(c) ?? 0) + d;
    if (v === 0) m.delete(c);
    else m.set(c, v);
  };

  const snap = (): Snapshot => {
    let opp = 0;
    for (const b of BOTS) if (b !== ME) opp += sum(startHeld.get(b)!);
    const myRack = new Map<string, number>();
    for (const [c, n] of startHeld.get(ME)!) inc(myRack, c, n);
    for (const [c, n] of wonHeld.get(ME)!) inc(myRack, c, n);
    return { bagRemaining: bag.length, oppUnrevealedStart: opp, myRack };
  };
  const push = (e: Ev) => {
    events.push(e);
    after.push(snap());
  };

  const playWord = (bot: bigint, word: string) => {
    // consume won tiles first, then start tiles
    for (const c of word) {
      if ((wonHeld.get(bot)!.get(c) ?? 0) > 0) inc(wonHeld.get(bot)!, c, -1);
      else inc(startHeld.get(bot)!, c, -1);
    }
    push({ t: "word", id: nextId++, bot, word });
  };

  const maybePlay = (bot: bigint) => {
    if (opts.mode === "clean") {
      if (bot === ME) {
        // I can play anything; my rack is known exactly.
        const held: string[] = [];
        for (const [c, n] of startHeld.get(ME)!) for (let i = 0; i < n; i++) held.push(c);
        for (const [c, n] of wonHeld.get(ME)!) for (let i = 0; i < n; i++) held.push(c);
        if (held.length < 2) return;
        const k = 2 + Math.floor(rng() * (held.length - 1));
        playWord(ME, shuffle(held, rng).slice(0, k).join(""));
        return;
      }
      const cand: string[] = [];
      for (const [c, n] of startHeld.get(bot)!) {
        if ((wonTotal.get(bot)!.get(c) ?? 0) === 0) for (let i = 0; i < n; i++) cand.push(c);
      }
      if (cand.length < 2) return;
      const k = 2 + Math.floor(rng() * (cand.length - 1));
      playWord(bot, shuffle(cand, rng).slice(0, k).join(""));
    } else {
      const held: string[] = [];
      for (const [c, n] of startHeld.get(bot)!) for (let i = 0; i < n; i++) held.push(c);
      for (const [c, n] of wonHeld.get(bot)!) for (let i = 0; i < n; i++) held.push(c);
      if (held.length < 2) return;
      const k = 2 + Math.floor(rng() * (held.length - 1));
      playWord(bot, shuffle(held, rng).slice(0, k).join(""));
    }
  };

  const noBidRate = opts.noBidRate ?? 0.1;
  while (bag.length > 0) {
    const letter = bag.shift()!;
    const id = nextId++;
    push({ t: "auction", id, letter });
    const noBid = rng() < noBidRate;
    if (noBid) {
      push({ t: "result", id, letter, winner: undefined, paid: 0 });
      continue;
    }
    const winner = BOTS[Math.floor(rng() * BOTS.length)]!;
    const paid = 1 + Math.floor(rng() * 12);
    inc(wonHeld.get(winner)!, letter);
    inc(wonTotal.get(winner)!, letter);
    push({ t: "result", id, letter, winner, paid });
    if (rng() < 0.5) maybePlay(winner);
  }
  if (opts.playOutAtEnd) {
    for (const b of BOTS) {
      if (b === ME) continue;
      const held: string[] = [];
      for (const [c, n] of startHeld.get(b)!) for (let i = 0; i < n; i++) held.push(c);
      for (const [c, n] of wonHeld.get(b)!) for (let i = 0; i < n; i++) held.push(c);
      if (held.length > 0) playWord(b, held.join(""));
    }
  }
  return { events, after, starts };
}

function feed(led: Ledger, e: Ev) {
  if (e.t === "auction") led.onAuction(e.id, e.letter);
  else if (e.t === "result") led.onResult(e.id, e.letter, e.winner, e.paid);
  else led.onWord(e.id, e.bot, e.word);
}

// ---------- sanity on the harness ----------

test("scripted match uses the full 98-tile bag with 5 starting tiles per bot and 68 auctions", () => {
  const s = scriptMatch(1, { mode: "random" });
  assert.equal(TOTAL, 98);
  let auctions = 0;
  for (const e of s.events) if (e.t === "auction") auctions++;
  assert.equal(auctions, 68);
  for (const b of BOTS) assert.equal(s.starts.get(b)!.length, 5);
});

// ---------- invariants after every event ----------

for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
  test(`clean match seed ${seed}: no negative counts and sum(unseen) == bag + opponents' unrevealed starting tiles after every event`, () => {
    const s = scriptMatch(seed, { mode: "clean" });
    const led = new Ledger(7n);
    const { warns } = captureWarn(() => {
      s.events.forEach((e, i) => {
        feed(led, e);
        const st = s.after[i]!;
        const u = led.unseen(ME, st.myRack);
        for (const [c, n] of u) assert.ok(n > 0, `event ${i}: unseen ${c} = ${n}`);
        assert.equal(
          sum(u),
          st.bagRemaining + st.oppUnrevealedStart,
          `event ${i} (${e.t}): sum(unseen)=${sum(u)} expected bag ${st.bagRemaining} + opp ${st.oppUnrevealedStart}`,
        );
      });
    });
    assert.deepEqual(warns, []);
  });
}

for (const seed of [100, 200, 300, 400, 500, 600, 700, 800]) {
  test(`random match seed ${seed}: never negative, never warns, sum(unseen) >= bag + opponents' unrevealed starting tiles`, () => {
    const s = scriptMatch(seed, { mode: "random", noBidRate: 0.2 });
    const led = new Ledger(8n);
    const { warns } = captureWarn(() => {
      s.events.forEach((e, i) => {
        feed(led, e);
        const st = s.after[i]!;
        const u = led.unseen(ME, st.myRack);
        for (const [c, n] of u) assert.ok(n > 0);
        assert.ok(
          sum(u) >= st.bagRemaining + st.oppUnrevealedStart,
          `event ${i}: ${sum(u)} < ${st.bagRemaining + st.oppUnrevealedStart}`,
        );
        // Opponents hold at most 5 hidden starting tiles each, so the slack is bounded.
        assert.ok(sum(u) <= st.bagRemaining + 25, `event ${i}: ${sum(u)} too large`);
      });
    });
    assert.deepEqual(warns, []);
  });
}

test("unseen never includes a letter I hold more of than the ledger could explain", () => {
  const s = scriptMatch(42, { mode: "clean" });
  const led = new Ledger(9n);
  s.events.forEach((e, i) => {
    feed(led, e);
    const st = s.after[i]!;
    const u = led.unseen(ME, st.myRack);
    for (const c of letters) {
      // BAG minus what I hold is an upper bound for what I haven't seen.
      assert.ok((u.get(c) ?? 0) <= BAG[c]! - (st.myRack.get(c) ?? 0), `event ${i} letter ${c}`);
    }
  });
});

// ---------- end of match ----------

for (const seed of [11, 22, 33, 44]) {
  test(`seed ${seed}: at match end, after every opponent plays out all tiles, sum(unseen) == 0`, () => {
    const s = scriptMatch(seed, { mode: "random", playOutAtEnd: true });
    const led = new Ledger(10n);
    for (const e of s.events) feed(led, e);
    const last = s.after[s.after.length - 1]!;
    assert.equal(last.bagRemaining, 0);
    assert.equal(last.oppUnrevealedStart, 0);
    const { value: u, warns } = captureWarn(() => led.unseen(ME, last.myRack));
    assert.deepEqual(warns, []);
    assert.equal(sum(u), 0, `leftover unseen: ${JSON.stringify([...u])}`);
  });
}

test("at match end with bag empty but opponents still hiding start tiles, sum(unseen) == their hidden count", () => {
  const s = scriptMatch(77, { mode: "clean" });
  const led = new Ledger(11n);
  for (const e of s.events) feed(led, e);
  const last = s.after[s.after.length - 1]!;
  assert.equal(last.bagRemaining, 0);
  assert.equal(sum(led.unseen(ME, last.myRack)), last.oppUnrevealedStart);
});

// ---------- idempotency ----------

test("feeding every event twice (immediately) gives the same unseen, won, played and paid as feeding once", () => {
  const s = scriptMatch(5, { mode: "random", playOutAtEnd: true });
  const once = new Ledger(1n);
  const twice = new Ledger(1n);
  s.events.forEach((e, i) => {
    feed(once, e);
    feed(twice, e);
    feed(twice, e);
    const st = s.after[i]!;
    assert.ok(mapsEqual(once.unseen(ME, st.myRack), twice.unseen(ME, st.myRack)), `event ${i}`);
  });
  assert.deepEqual(twice.paid, once.paid);
  assert.deepEqual(twice.revealed, once.revealed);
  assert.deepEqual([...twice.won], [...once.won]);
  assert.deepEqual([...twice.played], [...once.played]);
});

test("replaying the whole event stream a second time changes nothing", () => {
  const s = scriptMatch(6, { mode: "random" });
  const led = new Ledger(1n);
  for (const e of s.events) feed(led, e);
  const last = s.after[s.after.length - 1]!;
  const before = led.unseen(ME, last.myRack);
  const paidBefore = led.paid.slice();
  for (const e of s.events) feed(led, e);
  assert.ok(mapsEqual(before, led.unseen(ME, last.myRack)));
  assert.deepEqual(led.paid, paidBefore);
});

test("a duplicate result with a different payload is ignored (first one wins)", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "Q", 2n, 5);
  led.onResult(1n, "Q", 3n, 9);
  assert.equal(led.revealed[16], 1);
  assert.equal(led.won.get("2")![16], 1);
  assert.equal(led.won.get("3"), undefined);
  assert.deepEqual(led.paid, [5]);
});

test("a duplicate word play with the same playId is not counted twice", () => {
  const led = new Ledger(1n);
  led.onWord(1n, 2n, "CAT");
  led.onWord(1n, 2n, "CAT");
  assert.equal(led.played.get("2")![0], 1); // A
  assert.equal(led.played.get("2")![2], 1); // C
  assert.equal(led.played.get("2")![19], 1); // T
});

test("two different plays of the same word by the same bot are both counted", () => {
  const led = new Ledger(1n);
  led.onWord(1n, 2n, "CAT");
  led.onWord(2n, 2n, "CAT");
  assert.equal(led.played.get("2")![0], 2);
});

// ---------- auction / result bookkeeping ----------

test("onResult without a prior onAuction still reveals the letter exactly once", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "Z", 2n, 3);
  assert.equal(led.revealed[25], 1);
  led.onAuction(1n, "Z"); // late auction event for the same id
  assert.equal(led.revealed[25], 1);
});

test("onAuction then onResult reveals once; result with no winner records no payment", () => {
  const led = new Ledger(1n);
  led.onAuction(1n, "E");
  led.onResult(1n, "E", undefined, 0);
  assert.equal(led.revealed[4], 1);
  assert.deepEqual(led.paid, []);
  assert.equal(led.won.size, 0);
});

test("an unbid letter is discarded: it leaves unseen and is never attributed to anyone", () => {
  const led = new Ledger(1n);
  led.onAuction(1n, "J");
  led.onResult(1n, "J", undefined, 0);
  const u = led.unseen(ME, new Map());
  assert.equal(u.get("J"), undefined);
  assert.equal(sum(u), TOTAL - 1);
});

test("invalid letters (lowercase, digits, blanks) are ignored, not crashed on", () => {
  const led = new Ledger(1n);
  led.onAuction(1n, "a");
  led.onAuction(2n, "?");
  led.onAuction(3n, "");
  led.onResult(4n, "1", 2n, 2);
  led.onWord(5n, 2n, "ca t?");
  assert.equal(led.revealed.reduce((a, b) => a + b, 0), 0);
  assert.equal(led.played.get("2")!.reduce((a, b) => a + b, 0), 1); // only T
  assert.deepEqual(led.paid, [2]); // a winner was recorded even if the letter is odd
});

test("fresh ledger: unseen is the full bag minus my rack (my 5 starting tiles)", () => {
  const led = new Ledger(1n);
  const u = led.unseen(ME, rackOf("AEIQZ"));
  assert.equal(sum(u), TOTAL - 5);
  assert.equal(u.get("Q"), undefined);
  assert.equal(u.get("Z"), undefined);
  assert.equal(u.get("A"), 8);
  assert.equal(u.get("E"), 11);
  assert.equal(u.get("I"), 8);
});

test("letters I won are not double-subtracted from unseen", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "Q", ME, 4);
  const u = led.unseen(ME, rackOf("Q"));
  assert.equal(u.get("Q"), undefined);
  assert.equal(sum(u), TOTAL - 1);
});

test("letters I won and then played are accounted once", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "C", ME, 4);
  led.onResult(2n, "A", ME, 4);
  led.onWord(3n, ME, "CAT"); // T came from my starting rack
  const u = led.unseen(ME, new Map());
  assert.equal(u.get("C"), 1);
  assert.equal(u.get("A"), 8);
  assert.equal(u.get("T"), 5);
  assert.equal(sum(u), TOTAL - 3);
});

test("an opponent playing a letter it never won reveals one of its starting tiles", () => {
  const led = new Ledger(1n);
  led.onWord(1n, 2n, "ZA");
  const u = led.unseen(ME, new Map());
  assert.equal(u.get("Z"), undefined);
  assert.equal(u.get("A"), 8);
  assert.equal(sum(u), TOTAL - 2);
});

test("an opponent playing a letter it won reveals nothing new", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "Z", 2n, 3);
  led.onResult(2n, "A", 2n, 3);
  led.onWord(3n, 2n, "ZA");
  const u = led.unseen(ME, new Map());
  assert.equal(u.get("Z"), undefined);
  assert.equal(u.get("A"), 8);
  assert.equal(sum(u), TOTAL - 2);
});

test("an opponent playing more of a letter than it won reveals only the excess", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "E", 2n, 3);
  led.onWord(2n, 2n, "EEE");
  const u = led.unseen(ME, new Map());
  assert.equal(u.get("E"), 12 - 1 - 2);
});

test("different opponents' plays are attributed separately", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "E", 2n, 3); // bot 2 won an E
  led.onWord(2n, 3n, "EE"); // bot 3 plays two E from its start rack
  const u = led.unseen(ME, new Map());
  assert.equal(u.get("E"), 12 - 1 - 2);
});

test("unseen for a different observer (me = bot 2) uses bot 2's won/played", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "Q", 2n, 3);
  led.onWord(2n, 2n, "QAT");
  led.onWord(3n, 3n, "ZA");
  // As bot 2 with an empty rack now: Q was won (revealed), A and T were start tiles.
  const u = led.unseen(2n, new Map());
  assert.equal(u.get("Q"), undefined);
  assert.equal(u.get("A"), 9 - 1 - 1);
  assert.equal(u.get("T"), 5);
  assert.equal(u.get("Z"), undefined);
});

// ---------- negative clamping ----------

test("inconsistent events that over-reveal a letter warn once per call and clamp it out of the map", () => {
  const led = new Ledger(99n);
  led.onAuction(1n, "Z");
  led.onAuction(2n, "Z"); // only one Z exists
  const { value: u, warns } = captureWarn(() => led.unseen(ME, new Map()));
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /match 99/);
  assert.match(warns[0]!, /unseen Z = -1/);
  assert.equal(u.get("Z"), undefined);
  assert.equal(sum(u), TOTAL - 1);
});

test("my rack claiming more of a letter than exists warns and clamps", () => {
  const led = new Ledger(1n);
  const { value: u, warns } = captureWarn(() => led.unseen(ME, rackOf("QQ")));
  assert.equal(warns.length, 1);
  assert.equal(u.get("Q"), undefined);
});

test("unseen has no zero or negative entries, ever (fuzz)", () => {
  const rng = lcg(999);
  const led = new Ledger(1n);
  let id = 1n;
  const { warns } = captureWarn(() => {
    for (let i = 0; i < 300; i++) {
      const c = letters[Math.floor(rng() * 26)]!;
      const r = rng();
      if (r < 0.4) led.onAuction(id++, c);
      else if (r < 0.7) led.onResult(id++, c, BOTS[Math.floor(rng() * 6)], 1);
      else led.onWord(id++, BOTS[Math.floor(rng() * 6)]!, c + letters[Math.floor(rng() * 26)]!);
      for (const [, n] of led.unseen(ME, new Map())) assert.ok(n > 0);
    }
  });
  // Over-revealing is expected in a fuzz; only the shape of the map matters here.
  for (const w of warns) assert.match(w, /\(<0\), clamping/);
});

// ---------- avgPaid ----------

test("avgPaid is undefined before any winning result", () => {
  const led = new Ledger(1n);
  assert.equal(led.avgPaid(), undefined);
  led.onResult(1n, "A", undefined, 0);
  assert.equal(led.avgPaid(), undefined);
});

test("avgPaid averages exactly over fewer than N results", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "A", 2n, 4);
  led.onResult(2n, "B", 3n, 8);
  assert.equal(led.avgPaid(), 6);
  assert.equal(led.avgPaid(1), 8);
});

test("avgPaid windows over the last N payments only", () => {
  const led = new Ledger(1n);
  for (let i = 1; i <= 20; i++) led.onResult(BigInt(i), "A", 2n, i);
  // default window 15: payments 6..20
  assert.equal(led.avgPaid(), (6 + 20) / 2);
  assert.equal(led.avgPaid(5), (16 + 20) / 2);
  assert.equal(led.avgPaid(1), 20);
  assert.equal(led.avgPaid(100), (1 + 20) / 2);
});

test("avgPaid ignores unbid auctions and duplicate results", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "A", 2n, 10);
  led.onResult(2n, "B", undefined, 0);
  led.onResult(2n, "B", undefined, 0);
  led.onResult(1n, "A", 2n, 999);
  led.onResult(3n, "C", 4n, 20);
  assert.equal(led.avgPaid(), 15);
  assert.deepEqual(led.paid, [10, 20]);
});

test("avgPaid includes zero payments from winners that paid 0 (first-price 0 cannot win, but data is kept)", () => {
  const led = new Ledger(1n);
  led.onResult(1n, "A", 2n, 0);
  assert.equal(led.avgPaid(), 0);
});

test("avgPaid across a scripted match equals the mean of the last 15 winning results in close order", () => {
  const s = scriptMatch(3, { mode: "random" });
  const led = new Ledger(1n);
  const paids: number[] = [];
  for (const e of s.events) {
    feed(led, e);
    if (e.t === "result" && e.winner !== undefined) paids.push(e.paid);
  }
  const tail = paids.slice(-15);
  assert.equal(led.avgPaid(), tail.reduce((a, b) => a + b, 0) / tail.length);
  assert.deepEqual(led.paid, paids);
});

// ---------- reconnect: same events, different order ----------

function finalState(led: Ledger, myRack: Map<string, number>) {
  return {
    unseen: [...led.unseen(ME, myRack)].sort(),
    revealed: led.revealed.slice(),
    won: [...led.won].sort(([a], [b]) => a.localeCompare(b)),
    played: [...led.played].sort(([a], [b]) => a.localeCompare(b)),
  };
}

for (const seed of [7, 17, 27]) {
  test(`seed ${seed}: rebuilding from results-before-auctions gives the same state and the same paid history`, () => {
    const s = scriptMatch(seed, { mode: "random", playOutAtEnd: true });
    const live = new Ledger(1n);
    for (const e of s.events) feed(live, e);
    const rebuilt = new Ledger(1n);
    // Server subscription replay: all results, then all word plays, then all auctions.
    for (const e of s.events) if (e.t === "result") feed(rebuilt, e);
    for (const e of s.events) if (e.t === "word") feed(rebuilt, e);
    for (const e of s.events) if (e.t === "auction") feed(rebuilt, e);
    const last = s.after[s.after.length - 1]!;
    const { warns } = captureWarn(() => {
      assert.deepEqual(finalState(rebuilt, last.myRack), finalState(live, last.myRack));
    });
    assert.deepEqual(warns, []);
    assert.deepEqual(rebuilt.paid, live.paid);
    assert.equal(rebuilt.avgPaid(), live.avgPaid());
  });
}

test("rebuilding from a fully shuffled event set gives the same unseen (paid order may differ, multiset equal)", () => {
  const s = scriptMatch(31, { mode: "random", playOutAtEnd: true });
  const live = new Ledger(1n);
  for (const e of s.events) feed(live, e);
  const rebuilt = new Ledger(1n);
  for (const e of shuffle(s.events, lcg(4242))) feed(rebuilt, e);
  const last = s.after[s.after.length - 1]!;
  assert.deepEqual(finalState(rebuilt, last.myRack), finalState(live, last.myRack));
  assert.deepEqual(rebuilt.paid.slice().sort((a, b) => a - b), live.paid.slice().sort((a, b) => a - b));
});

test("reconnect mid-match: replaying the prefix in a different order, then continuing live, matches a live ledger at every later event", () => {
  const s = scriptMatch(53, { mode: "clean" });
  const cut = Math.floor(s.events.length / 2);
  const live = new Ledger(1n);
  for (const e of s.events) feed(live, e);
  const rebuilt = new Ledger(1n);
  const prefix = s.events.slice(0, cut);
  for (const e of prefix) if (e.t === "word") feed(rebuilt, e);
  for (const e of prefix) if (e.t === "result") feed(rebuilt, e);
  for (const e of prefix) if (e.t === "auction") feed(rebuilt, e);
  const ref = new Ledger(1n);
  for (const e of prefix) feed(ref, e);
  for (let i = cut; i < s.events.length; i++) {
    feed(rebuilt, s.events[i]!);
    feed(ref, s.events[i]!);
    const st = s.after[i]!;
    assert.ok(mapsEqual(rebuilt.unseen(ME, st.myRack), ref.unseen(ME, st.myRack)), `event ${i}`);
  }
  const last = s.after[s.after.length - 1]!;
  assert.deepEqual(finalState(rebuilt, last.myRack), finalState(live, last.myRack));
});

test("reconnect with an overlapping replay (events seen live are re-delivered) is harmless", () => {
  const s = scriptMatch(61, { mode: "random", playOutAtEnd: true });
  const live = new Ledger(1n);
  for (const e of s.events) feed(live, e);
  const led = new Ledger(1n);
  const cut = Math.floor(s.events.length * 0.6);
  for (const e of s.events.slice(0, cut)) feed(led, e);
  // Reconnect: the server replays everything so far (including what we saw), then live continues.
  for (const e of s.events.slice(0, cut)) if (e.t === "result") feed(led, e);
  for (const e of s.events.slice(0, cut)) if (e.t === "auction") feed(led, e);
  for (const e of s.events.slice(0, cut)) if (e.t === "word") feed(led, e);
  for (const e of s.events.slice(cut)) feed(led, e);
  const last = s.after[s.after.length - 1]!;
  assert.deepEqual(finalState(led, last.myRack), finalState(live, last.myRack));
  assert.deepEqual(led.paid, live.paid);
});

// ---------- separate matches ----------

test("two ledgers for different matches do not share state", () => {
  const a = new Ledger(1n);
  const b = new Ledger(2n);
  a.onResult(1n, "Q", 2n, 3);
  assert.equal(b.revealed[16], 0);
  assert.equal(b.avgPaid(), undefined);
  assert.equal(sum(b.unseen(ME, new Map())), TOTAL);
});

test("auction ids are compared by value: 1n and BigInt(1) are the same auction", () => {
  const led = new Ledger(1n);
  led.onAuction(1n, "Q");
  led.onAuction(BigInt(1), "Q");
  led.onResult(BigInt("1"), "Q", 2n, 2);
  assert.equal(led.revealed[16], 1);
});

test("full-match performance: 6-bot match with unseen() after every event stays fast", () => {
  const s = scriptMatch(9, { mode: "random", playOutAtEnd: true });
  const led = new Ledger(1n);
  const t0 = performance.now();
  s.events.forEach((e, i) => {
    feed(led, e);
    led.unseen(ME, s.after[i]!.myRack);
  });
  assert.ok(performance.now() - t0 < 200, "ledger too slow for a 1 s auction cadence");
});
