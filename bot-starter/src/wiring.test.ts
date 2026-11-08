// Tests for the live wiring in src/index.ts (buildView / bidOn / playWords /
// joinLobby). index.ts connects on import and exports nothing, so the
// functions below are copied from it verbatim, with two changes:
//   1. module-level state (myBotId, ledgers, myBids, inflightWords,
//      rejectedStreak, lastJoin, conn) lives in a Harness so each test resets;
//   2. decideBid / chooseWords / Date.now are injectable so tests are
//      deterministic (they default to the real brain).
// A refactor exporting these from index.ts (or moving them to a wiring.ts
// that index.ts imports) would let these tests run against the real code.
//
// Run: node --import tsx --test src/wiring.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseWords as realChooseWords, decideBid as realDecideBid, type MatchView } from "./brain.js";
import { Ledger } from "./ledger.js";
import { canSpell, isWord, subtractWord, toCounts, wordReward } from "./words.js";

// ---------- Fake SpacetimeDB ----------

type Tag<T extends string> = { tag: T };
interface MatchStateRow {
  id: bigint;
  status: Tag<"Running" | "Ended" | "Pending">;
  bagTotal: number;
  auctionType: Tag<"Vickrey" | "FirstPrice">;
}
interface ParticipantRow { matchId: bigint; botId: bigint; balance: bigint; score: bigint }
interface RackRow { matchId: bigint; letter: string; count: number }
interface AuctionRow { id: bigint; matchId: bigint; letter: string; status: Tag<"Open" | "Closed"> }
interface LobbyRow { id: bigint; status: Tag<"Open" | "Closed"> }
interface LobbyMemberRow { lobbyId: bigint; botId: bigint }

class Table<R> {
  rows: R[] = [];
  constructor(private key?: keyof R) {}
  iter() { return this.rows[Symbol.iterator](); }
  get id() {
    const key = this.key;
    return { find: (v: unknown) => this.rows.find((r) => key !== undefined && r[key] === v) };
  }
}

interface Call { name: string; args: Record<string, unknown> }
type Controlled = { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void };
function controlled(): Controlled {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeDb {
  matchState = new Table<MatchStateRow>("id");
  matchParticipant = new Table<ParticipantRow>();
  myRack = new Table<RackRow>();
  auction = new Table<AuctionRow>("id");
  auctionResult = new Table<{ matchId: bigint; auctionId: bigint; letter: string; winnerBotId?: bigint; paid: bigint }>();
  wordPlay = new Table<{ id: bigint; matchId: bigint; botId: bigint; word: string }>();
  lobby = new Table<LobbyRow>("id");
  lobbyMember = new Table<LobbyMemberRow>();
}

class FakeConn {
  db = new FakeDb();
  calls: Call[] = [];
  pending: Controlled[] = [];
  // Which reducers resolve themselves (default) vs. hand back a controlled promise.
  manual = new Set<string>();
  reducers = {
    submitBid: (args: { auctionId: bigint; amount: bigint }) => this.call("submitBid", args),
    submitWord: (args: { matchId: bigint; word: string }) => this.call("submitWord", args),
    joinLobby: (args: Record<string, never>) => this.call("joinLobby", args),
  };
  private call(name: string, args: Record<string, unknown>): Promise<void> {
    this.calls.push({ name, args });
    if (this.manual.has(name)) {
      const c = controlled();
      this.pending.push(c);
      return c.promise;
    }
    return Promise.resolve();
  }
  of(name: string) { return this.calls.filter((c) => c.name === name); }
}

// ---------- Copied wiring (see header) ----------

class Harness {
  myBotId: bigint | null = 1n;
  NO_LOBBY = false;
  ledgers = new Map<string, Ledger>();
  myBids = new Map<string, { bid: number; value: number; bagTotal: number }>();
  inflightWords = new Map<string, number>();
  rejectedStreak = new Map<string, number>();
  lastJoin = 0;
  conn: FakeConn | null;
  warnings: string[] = [];
  logs: string[] = [];
  now = () => Date.now();
  decideBid: (v: MatchView, l: string) => { bid: number; value: number } = realDecideBid;
  chooseWords: (v: MatchView) => string[] = realChooseWords;
  playWordsCalls = 0;

  constructor(conn: FakeConn) { this.conn = conn; }

  warn = (...a: unknown[]) => { this.warnings.push(a.map(String).join(" ")); };
  log = (...a: unknown[]) => { this.logs.push(a.map(String).join(" ")); };

  safe<T extends unknown[]>(name: string, fn: (...a: T) => void) {
    return (...a: T) => {
      try { fn(...a); } catch (e) { this.warn(`${name} threw:`, e instanceof Error ? e.stack : e); }
    };
  }

  ledgerFor(matchId: bigint): Ledger {
    const k = String(matchId);
    let l = this.ledgers.get(k);
    if (!l) this.ledgers.set(k, (l = new Ledger(matchId)));
    return l;
  }

  rackFor(c: FakeConn, matchId: bigint): Map<string, number> {
    const rack = new Map<string, number>();
    for (const h of c.db.myRack.iter()) {
      if (h.matchId !== matchId) continue;
      rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
    }
    return rack;
  }

  myMatches(c: FakeConn): bigint[] {
    const out: bigint[] = [];
    if (this.myBotId === null) return out;
    for (const p of c.db.matchParticipant.iter()) {
      if (p.botId !== this.myBotId) continue;
      const m = c.db.matchState.id.find(p.matchId);
      if (m?.status.tag === "Running") out.push(p.matchId);
    }
    return out;
  }

  buildView(c: FakeConn, matchId: bigint): MatchView | null {
    if (this.myBotId === null) return null;
    const m = c.db.matchState.id.find(matchId);
    if (!m || m.status.tag !== "Running") return null;
    let me: { balance: number; score: number } | null = null;
    const opponents: { balance: number; score: number }[] = [];
    for (const p of c.db.matchParticipant.iter()) {
      if (p.matchId !== matchId) continue;
      const row = { balance: Number(p.balance), score: Number(p.score) };
      if (p.botId === this.myBotId) me = row;
      else opponents.push(row);
    }
    if (!me) return null;
    const rack = this.rackFor(c, matchId);
    const led = this.ledgerFor(matchId);
    return {
      bagTotal: m.bagTotal,
      auctionType: m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey",
      myBalance: me.balance,
      myScore: me.score,
      myRack: rack,
      unseen: led.unseen(this.myBotId, rack),
      opponents,
      numPlayers: opponents.length + 1,
      avgPaid: led.avgPaid(),
    };
  }

  bidOn(c: FakeConn, auctionId: bigint, matchId: bigint, letter: string) {
    if (this.myBotId === null) return;
    const a = c.db.auction.id.find(auctionId);
    if (!a || a.status.tag !== "Open") return;
    const view = this.buildView(c, matchId);
    if (!view) return;
    const t0 = performance.now();
    const { bid, value } = this.decideBid(view, letter);
    const ms = performance.now() - t0;
    const k = String(auctionId);
    const prev = this.myBids.get(k);
    if (prev && prev.bid === bid) return;
    if (!prev && bid <= 0) {
      this.myBids.set(k, { bid: 0, value, bagTotal: view.bagTotal });
      return;
    }
    this.myBids.set(k, { bid, value, bagTotal: view.bagTotal });
    if (ms > 50) this.warn(`slow decideBid ${ms.toFixed(0)}ms`);
    c.reducers
      .submitBid({ auctionId, amount: BigInt(bid) })
      .catch((e: unknown) => this.warn(`bid ${bid} on '${letter}' (auction ${auctionId}) failed: ${e instanceof Error ? e.message : e}`));
  }

  rebidOpen(c: FakeConn) {
    for (const a of c.db.auction.iter()) {
      if (a.status.tag !== "Open") continue;
      if (!this.myMatches(c).some((m) => m === a.matchId)) continue;
      this.bidOn(c, a.id, a.matchId, a.letter);
    }
  }

  playWords(c: FakeConn) {
    this.playWordsCalls++;
    if (this.myBotId === null) return;
    for (const matchId of this.myMatches(c)) {
      const mk = String(matchId);
      if ((this.inflightWords.get(mk) ?? 0) > 0) continue;
      const view = this.buildView(c, matchId);
      if (!view) continue;
      const words = this.chooseWords(view);
      if (words.length === 0) continue;
      let rack = toCounts(view.myRack);
      const ok: string[] = [];
      for (const w of words) {
        if (!isWord(w) || !canSpell(w, rack)) {
          this.warn(`refusing '${w}': not spellable/valid`);
          continue;
        }
        rack = subtractWord(rack, w);
        ok.push(w);
      }
      if (ok.length === 0) continue;
      this.inflightWords.set(mk, ok.length);
      for (const word of ok) {
        this.log(`match ${matchId} bag=${view.bagTotal}: playing '${word}' (+${wordReward(word)})`);
        c.reducers
          .submitWord({ matchId, word })
          .then(() => this.rejectedStreak.set(mk, 0))
          .catch((e: unknown) => {
            this.warn(`word '${word}' rejected: ${e instanceof Error ? e.message : e}`);
            this.rejectedStreak.set(mk, (this.rejectedStreak.get(mk) ?? 0) + 1);
          })
          .finally(() => {
            this.inflightWords.set(mk, Math.max(0, (this.inflightWords.get(mk) ?? 1) - 1));
            if ((this.inflightWords.get(mk) ?? 0) === 0 && (this.rejectedStreak.get(mk) ?? 0) < 5) {
              setImmediate(this.safe("playWords", () => this.conn && this.playWords(this.conn)));
            }
          });
      }
    }
  }

  joinLobby(c: FakeConn) {
    if (this.myBotId === null || this.NO_LOBBY) return;
    if (this.myMatches(c).length > 0) return;
    if (this.now() - this.lastJoin < 3000) return;
    const openLobby = Array.from(c.db.lobby.iter()).find((l) => l.status.tag === "Open");
    const alreadyIn =
      openLobby !== undefined &&
      Array.from(c.db.lobbyMember.iter()).some((lm) => lm.lobbyId === openLobby.id && lm.botId === this.myBotId);
    if (alreadyIn) return;
    this.lastJoin = this.now();
    this.log("joining lobby");
    c.reducers.joinLobby({}).catch((e: unknown) => this.log(`join lobby refused: ${e instanceof Error ? e.message : e}`));
  }
}

// ---------- Fixtures ----------

const M = 10n;
const ME = 1n;

function seatedMatch(opts: { bag?: number; balance?: number; rack?: string; status?: "Running" | "Ended" | "Pending"; auctionType?: "Vickrey" | "FirstPrice"; opponents?: number[] } = {}) {
  const c = new FakeConn();
  c.db.matchState.rows.push({ id: M, status: { tag: opts.status ?? "Running" }, bagTotal: opts.bag ?? 40, auctionType: { tag: opts.auctionType ?? "Vickrey" } });
  c.db.matchParticipant.rows.push({ matchId: M, botId: ME, balance: BigInt(opts.balance ?? 100), score: 0n });
  for (const [i, b] of (opts.opponents ?? [100, 100]).entries())
    c.db.matchParticipant.rows.push({ matchId: M, botId: BigInt(50 + i), balance: BigInt(b), score: BigInt(i) });
  for (const ch of opts.rack ?? "") c.db.myRack.rows.push({ matchId: M, letter: ch, count: 1 });
  const h = new Harness(c);
  return { c, h };
}
function openAuction(c: FakeConn, id: bigint, letter: string, matchId = M) {
  c.db.auction.rows.push({ id, matchId, letter, status: { tag: "Open" } });
}
const flush = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------- buildView ----------

test("buildView returns null for an ended match", () => {
  const { c, h } = seatedMatch({ status: "Ended", rack: "CAT" });
  assert.equal(h.buildView(c, M), null);
});

test("buildView returns null for a pending match and for an unknown match id", () => {
  const { c, h } = seatedMatch({ status: "Pending" });
  assert.equal(h.buildView(c, M), null);
  assert.equal(h.buildView(c, 999n), null);
});

test("buildView returns null before my bot id is known", () => {
  const { c, h } = seatedMatch();
  h.myBotId = null;
  assert.equal(h.buildView(c, M), null);
});

test("buildView returns null when I am not seated in that match", () => {
  const { c, h } = seatedMatch();
  h.myBotId = 77n;
  assert.equal(h.buildView(c, M), null);
});

test("buildView fills balance, rack, opponents, numPlayers, auctionType", () => {
  const { c, h } = seatedMatch({ bag: 12, balance: 37, rack: "AAB", auctionType: "FirstPrice", opponents: [20, 55, 3] });
  const v = h.buildView(c, M)!;
  assert.ok(v);
  assert.equal(v.bagTotal, 12);
  assert.equal(v.myBalance, 37);
  assert.equal(v.myScore, 0);
  assert.equal(v.auctionType, "FirstPrice");
  assert.deepEqual([...v.myRack], [["A", 2], ["B", 1]]);
  assert.equal(v.numPlayers, 4);
  assert.deepEqual(v.opponents.map((o) => o.balance), [20, 55, 3]);
  assert.equal(v.avgPaid, undefined);
});

test("buildView ignores rack rows and participants from other matches", () => {
  const { c, h } = seatedMatch({ rack: "AB" });
  c.db.myRack.rows.push({ matchId: 99n, letter: "Z", count: 3 });
  c.db.matchParticipant.rows.push({ matchId: 99n, botId: 60n, balance: 5n, score: 0n });
  const v = h.buildView(c, M)!;
  assert.equal(v.myRack.get("Z"), undefined);
  assert.equal(v.numPlayers, 3);
});

test("buildView sums duplicate rack rows for the same letter", () => {
  const { c, h } = seatedMatch();
  c.db.myRack.rows.push({ matchId: M, letter: "E", count: 2 }, { matchId: M, letter: "E", count: 1 });
  assert.equal(h.buildView(c, M)!.myRack.get("E"), 3);
});

test("buildView avgPaid reflects the ledger's recorded prices", () => {
  const { c, h } = seatedMatch();
  const led = h.ledgerFor(M);
  led.onResult(1n, "A", 50n, 4);
  led.onResult(2n, "B", 51n, 8);
  led.onResult(3n, "C", undefined, 0); // no winner: not a price
  assert.equal(h.buildView(c, M)!.avgPaid, 6);
});

test("buildView maps non-FirstPrice auction types to Vickrey", () => {
  const { c, h } = seatedMatch({ auctionType: "Vickrey" });
  assert.equal(h.buildView(c, M)!.auctionType, "Vickrey");
});

test("buildView unseen excludes my rack and revealed letters", () => {
  const { c, h } = seatedMatch({ rack: "Q" });
  const before = h.buildView(c, M)!.unseen.get("Q") ?? 0;
  assert.equal(before, 0); // only one Q in the bag and it is on my rack
  const v = h.buildView(c, M)!;
  assert.equal(v.unseen.get("Z"), 1);
});

// ---------- myMatches ----------

test("myMatches lists only running matches I am seated in", () => {
  const { c, h } = seatedMatch();
  c.db.matchState.rows.push({ id: 11n, status: { tag: "Ended" }, bagTotal: 0, auctionType: { tag: "Vickrey" } });
  c.db.matchParticipant.rows.push({ matchId: 11n, botId: ME, balance: 1n, score: 0n });
  c.db.matchState.rows.push({ id: 12n, status: { tag: "Running" }, bagTotal: 5, auctionType: { tag: "Vickrey" } });
  c.db.matchParticipant.rows.push({ matchId: 12n, botId: 50n, balance: 1n, score: 0n });
  assert.deepEqual(h.myMatches(c), [M]);
  h.myBotId = null;
  assert.deepEqual(h.myMatches(c), []);
});

// ---------- bidOn ----------

test("bidOn sends a bid once and records it", () => {
  const { c, h } = seatedMatch({ rack: "CAT", bag: 30 });
  openAuction(c, 1n, "S");
  h.decideBid = () => ({ bid: 7, value: 3 });
  h.bidOn(c, 1n, M, "S");
  assert.equal(c.of("submitBid").length, 1);
  assert.deepEqual(c.of("submitBid")[0]!.args, { auctionId: 1n, amount: 7n });
  assert.deepEqual(h.myBids.get("1"), { bid: 7, value: 3, bagTotal: 30 });
});

test("bidOn does not resend an unchanged bid", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  openAuction(c, 1n, "S");
  h.decideBid = () => ({ bid: 7, value: 3 });
  h.bidOn(c, 1n, M, "S");
  h.bidOn(c, 1n, M, "S");
  h.bidOn(c, 1n, M, "S");
  assert.equal(c.of("submitBid").length, 1);
});

test("bidOn resends when the decided bid changes", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  openAuction(c, 1n, "S");
  let n = 5;
  h.decideBid = () => ({ bid: n, value: 3 });
  h.bidOn(c, 1n, M, "S");
  n = 9;
  h.bidOn(c, 1n, M, "S");
  n = 9;
  h.bidOn(c, 1n, M, "S");
  assert.deepEqual(c.of("submitBid").map((x) => x.args.amount), [5n, 9n]);
});

test("bidOn never sends a zero first bid but remembers it", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  openAuction(c, 1n, "S");
  h.decideBid = () => ({ bid: 0, value: 0 });
  h.bidOn(c, 1n, M, "S");
  h.bidOn(c, 1n, M, "S");
  assert.equal(c.of("submitBid").length, 0);
  assert.equal(h.myBids.get("1")?.bid, 0);
});

test("bidOn after a zero first bid sends a later positive bid", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  openAuction(c, 1n, "S");
  let b = 0;
  h.decideBid = () => ({ bid: b, value: 1 });
  h.bidOn(c, 1n, M, "S");
  b = 4;
  h.bidOn(c, 1n, M, "S");
  assert.deepEqual(c.of("submitBid").map((x) => x.args.amount), [4n]);
});

test("bidOn skips closed and unknown auctions", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  c.db.auction.rows.push({ id: 1n, matchId: M, letter: "S", status: { tag: "Closed" } });
  h.decideBid = () => ({ bid: 7, value: 3 });
  h.bidOn(c, 1n, M, "S");
  h.bidOn(c, 2n, M, "S");
  assert.equal(c.of("submitBid").length, 0);
  assert.equal(h.myBids.size, 0);
});

test("bidOn skips when the match is not running or I have no bot id", () => {
  const { c, h } = seatedMatch({ rack: "CAT", status: "Ended" });
  openAuction(c, 1n, "S");
  h.decideBid = () => ({ bid: 7, value: 3 });
  h.bidOn(c, 1n, M, "S");
  assert.equal(c.of("submitBid").length, 0);
  const { c: c2, h: h2 } = seatedMatch({ rack: "CAT" });
  openAuction(c2, 1n, "S");
  h2.myBotId = null;
  h2.decideBid = () => ({ bid: 7, value: 3 });
  h2.bidOn(c2, 1n, M, "S");
  assert.equal(c2.of("submitBid").length, 0);
});

test("bidOn with the real brain never sends a bid above balance (many states)", () => {
  const racks = ["", "A", "CAT", "QZXJ", "EEEIOU", "RSTLNE", "AEIOUAEIOU", "BBBBB", "SATINE", "ZQJXKWV"];
  const letters = ["A", "E", "S", "Q", "Z", "X", "U", "T"];
  const balances = [0, 1, 2, 3, 5, 10, 25, 60, 100, 250];
  const bags = [0, 1, 2, 3, 4, 6, 10, 20, 40, 68];
  let sent = 0;
  for (const auctionType of ["Vickrey", "FirstPrice"] as const)
    for (const balance of balances)
      for (const bag of bags)
        for (const rack of racks)
          for (const letter of letters) {
            const { c, h } = seatedMatch({ rack, bag, balance, auctionType, opponents: [balance, 100, 7] });
            openAuction(c, 1n, letter);
            h.bidOn(c, 1n, M, letter);
            for (const call of c.of("submitBid")) {
              const amt = call.args.amount as bigint;
              assert.ok(amt >= 1n, `bid ${amt} < 1 (${auctionType} bal=${balance} bag=${bag} rack=${rack} ${letter})`);
              assert.ok(amt <= BigInt(balance), `bid ${amt} > balance ${balance} (${auctionType} bag=${bag} rack=${rack} ${letter})`);
              sent++;
            }
          }
  assert.ok(sent > 100, `expected many bids to be sent, got ${sent}`);
});

test("bidOn with zero balance never sends", () => {
  for (const bag of [0, 1, 5, 40]) {
    const { c, h } = seatedMatch({ rack: "RSTLNE", balance: 0, bag });
    openAuction(c, 1n, "A");
    h.bidOn(c, 1n, M, "A");
    assert.equal(c.of("submitBid").length, 0, `bag=${bag}`);
  }
});

test("bidOn on the final auction (bag 0) bids the whole balance", () => {
  const { c, h } = seatedMatch({ rack: "CAT", balance: 42, bag: 0 });
  openAuction(c, 1n, "Z");
  h.bidOn(c, 1n, M, "Z");
  assert.deepEqual(c.of("submitBid").map((x) => x.args.amount), [42n]);
});

test("bidOn logs a warning when submitBid rejects and keeps the recorded bid", async () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  openAuction(c, 1n, "S");
  c.manual.add("submitBid");
  h.decideBid = () => ({ bid: 7, value: 3 });
  h.bidOn(c, 1n, M, "S");
  c.pending[0]!.reject(new Error("Bid exceeds balance"));
  await flush();
  assert.ok(h.warnings.some((w) => w.includes("bid 7 on 'S'") && w.includes("Bid exceeds balance")), h.warnings.join("\n"));
  assert.equal(h.myBids.get("1")?.bid, 7);
});

test("bidOn uses bigint amounts (not floats)", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  openAuction(c, 1n, "S");
  h.decideBid = () => ({ bid: 7, value: 3 });
  h.bidOn(c, 1n, M, "S");
  assert.equal(typeof c.of("submitBid")[0]!.args.amount, "bigint");
  assert.equal(typeof c.of("submitBid")[0]!.args.auctionId, "bigint");
});

test("bidOn passes the letter and view through to decideBid", () => {
  const { c, h } = seatedMatch({ rack: "CAT", bag: 17, balance: 33 });
  openAuction(c, 1n, "S");
  let seen: [MatchView, string] | null = null;
  h.decideBid = (v, l) => { seen = [v, l]; return { bid: 1, value: 1 }; };
  h.bidOn(c, 1n, M, "S");
  assert.ok(seen);
  assert.equal(seen![1], "S");
  assert.equal(seen![0].bagTotal, 17);
  assert.equal(seen![0].myBalance, 33);
});

// ---------- rebidOpen ----------

test("rebidOpen bids on open auctions of my running matches only", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  openAuction(c, 1n, "S");
  c.db.auction.rows.push({ id: 2n, matchId: M, letter: "T", status: { tag: "Closed" } });
  c.db.matchState.rows.push({ id: 20n, status: { tag: "Running" }, bagTotal: 5, auctionType: { tag: "Vickrey" } });
  openAuction(c, 3n, "U", 20n); // not seated there
  h.decideBid = () => ({ bid: 2, value: 1 });
  h.rebidOpen(c);
  assert.deepEqual(c.of("submitBid").map((x) => x.args.auctionId), [1n]);
});

test("rebidOpen twice without changes sends nothing new", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  openAuction(c, 1n, "S");
  h.decideBid = () => ({ bid: 2, value: 1 });
  h.rebidOpen(c);
  h.rebidOpen(c);
  assert.equal(c.of("submitBid").length, 1);
});

// ---------- playWords ----------

test("playWords submits the chosen words and sets the in-flight count", () => {
  const { c, h } = seatedMatch({ rack: "CATDOG" });
  c.manual.add("submitWord");
  h.chooseWords = () => ["CAT", "DOG"];
  h.playWords(c);
  assert.deepEqual(c.of("submitWord").map((x) => x.args.word), ["CAT", "DOG"]);
  assert.equal(h.inflightWords.get(String(M)), 2);
});

test("playWords does nothing while a word is in flight", () => {
  const { c, h } = seatedMatch({ rack: "CATDOG" });
  c.manual.add("submitWord");
  h.chooseWords = () => ["CAT"];
  h.playWords(c);
  h.playWords(c);
  h.playWords(c);
  assert.equal(c.of("submitWord").length, 1);
});

test("a rejected submitWord releases the in-flight lock", async () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  c.manual.add("submitWord");
  h.chooseWords = () => ["CAT"];
  h.playWords(c);
  assert.equal(h.inflightWords.get(String(M)), 1);
  c.pending[0]!.reject(new Error("Not your tiles"));
  await flush();
  assert.equal(h.inflightWords.get(String(M)), 0);
  assert.equal(h.rejectedStreak.get(String(M)), 1);
  assert.ok(h.warnings.some((w) => w.includes("word 'CAT' rejected")));
});

test("a resolved submitWord releases the lock, resets the streak and retriggers playWords", async () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  c.manual.add("submitWord");
  h.rejectedStreak.set(String(M), 3);
  h.chooseWords = () => ["CAT"];
  h.playWords(c);
  const before = h.playWordsCalls;
  c.pending[0]!.resolve();
  await flush();
  assert.equal(h.inflightWords.get(String(M)), 0);
  assert.equal(h.rejectedStreak.get(String(M)), 0);
  assert.ok(h.playWordsCalls > before, "playWords should have been rescheduled");
});

test("after a rejection playWords retries until 5 rejections, then stops", async () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  c.manual.add("submitWord");
  h.chooseWords = () => ["CAT"];
  h.playWords(c);
  for (let i = 0; i < 5; i++) {
    assert.equal(c.of("submitWord").length, i + 1, `attempt ${i + 1} should have been sent`);
    c.pending[i]!.reject(new Error("rejected"));
    await flush();
  }
  assert.equal(h.rejectedStreak.get(String(M)), 5);
  // No 6th attempt was scheduled.
  await flush();
  await tick();
  assert.equal(c.of("submitWord").length, 5);
  assert.equal(h.inflightWords.get(String(M)), 0);
});

test("after the 5-rejection stop, an external playWords call still goes through (lock is free)", async () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  c.manual.add("submitWord");
  h.chooseWords = () => ["CAT"];
  h.rejectedStreak.set(String(M), 5);
  h.playWords(c);
  assert.equal(c.of("submitWord").length, 1);
});

test("multiple words in flight: lock released only when all settle", async () => {
  const { c, h } = seatedMatch({ rack: "CATDOG" });
  c.manual.add("submitWord");
  h.chooseWords = () => ["CAT", "DOG"];
  h.playWords(c);
  c.pending[0]!.resolve();
  await flush();
  assert.equal(h.inflightWords.get(String(M)), 1);
  const before = h.playWordsCalls;
  c.pending[1]!.reject(new Error("x"));
  await flush();
  assert.equal(h.inflightWords.get(String(M)), 0);
  assert.ok(h.playWordsCalls > before);
});

test("playWords refuses words not in the dictionary or not spellable from the rack", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  h.chooseWords = () => ["XQZV", "DOG", "CAT"];
  h.playWords(c);
  assert.deepEqual(c.of("submitWord").map((x) => x.args.word), ["CAT"]);
  assert.equal(h.warnings.filter((w) => w.startsWith("refusing")).length, 2);
});

test("playWords refuses a second word that reuses tiles of the first", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  h.chooseWords = () => ["CAT", "ACT"];
  h.playWords(c);
  assert.deepEqual(c.of("submitWord").map((x) => x.args.word), ["CAT"]);
});

test("playWords sends nothing and keeps the lock free when all words are refused", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  h.chooseWords = () => ["DOG"];
  h.playWords(c);
  assert.equal(c.of("submitWord").length, 0);
  assert.equal(h.inflightWords.get(String(M)) ?? 0, 0);
});

test("playWords does nothing when chooseWords returns nothing or match is not running", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  h.chooseWords = () => [];
  h.playWords(c);
  assert.equal(c.of("submitWord").length, 0);
  const { c: c2, h: h2 } = seatedMatch({ rack: "CAT", status: "Ended" });
  h2.chooseWords = () => ["CAT"];
  h2.playWords(c2);
  assert.equal(c2.of("submitWord").length, 0);
});

test("playWords handles two running matches independently", async () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  c.db.matchState.rows.push({ id: 20n, status: { tag: "Running" }, bagTotal: 5, auctionType: { tag: "Vickrey" } });
  c.db.matchParticipant.rows.push({ matchId: 20n, botId: ME, balance: 50n, score: 0n });
  for (const ch of "DOG") c.db.myRack.rows.push({ matchId: 20n, letter: ch, count: 1 });
  c.manual.add("submitWord");
  h.chooseWords = (v) => (v.myRack.has("C") ? ["CAT"] : ["DOG"]);
  h.playWords(c);
  assert.deepEqual(c.of("submitWord").map((x) => [x.args.matchId, x.args.word]), [[M, "CAT"], [20n, "DOG"]]);
  c.pending[0]!.reject(new Error("no"));
  await flush();
  assert.equal(h.inflightWords.get(String(M)), 0);
  assert.equal(h.inflightWords.get("20"), 1);
});

test("playWords with the real brain in the endgame plays only spellable dictionary words", () => {
  const { c, h } = seatedMatch({ rack: "RETAINS", bag: 0, balance: 10 });
  h.playWords(c);
  const words = c.of("submitWord").map((x) => x.args.word as string);
  assert.ok(words.length >= 1);
  let rack = toCounts(h.buildView(c, M)!.myRack);
  for (const w of words) {
    assert.ok(isWord(w), w);
    assert.ok(canSpell(w, rack), w);
    rack = subtractWord(rack, w);
  }
  assert.equal(h.warnings.length, 0);
});

test("playWords after a rejection does not get stuck when conn is null", async () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  c.manual.add("submitWord");
  h.chooseWords = () => ["CAT"];
  h.playWords(c);
  h.conn = null;
  c.pending[0]!.reject(new Error("x"));
  await flush();
  assert.equal(h.inflightWords.get(String(M)), 0);
  assert.equal(c.of("submitWord").length, 1);
});

// ---------- joinLobby ----------

function lobbyConn(opts: { inMatch?: boolean; open?: boolean; member?: boolean } = {}) {
  const c = new FakeConn();
  if (opts.inMatch) {
    c.db.matchState.rows.push({ id: M, status: { tag: "Running" }, bagTotal: 10, auctionType: { tag: "Vickrey" } });
    c.db.matchParticipant.rows.push({ matchId: M, botId: ME, balance: 100n, score: 0n });
  }
  if (opts.open ?? true) c.db.lobby.rows.push({ id: 5n, status: { tag: "Open" } });
  if (opts.member) c.db.lobbyMember.rows.push({ lobbyId: 5n, botId: ME });
  const h = new Harness(c);
  let t = 100_000;
  h.now = () => t;
  return { c, h, advance: (ms: number) => { t += ms; } };
}

test("joinLobby joins when idle and not already a member", () => {
  const { c, h } = lobbyConn();
  h.joinLobby(c);
  assert.equal(c.of("joinLobby").length, 1);
});

test("joinLobby is rate-limited to one call per 3 s", () => {
  const { c, h, advance } = lobbyConn();
  h.joinLobby(c);
  h.joinLobby(c);
  advance(2999);
  h.joinLobby(c);
  assert.equal(c.of("joinLobby").length, 1);
  advance(1);
  h.joinLobby(c);
  assert.equal(c.of("joinLobby").length, 2);
});

test("joinLobby is skipped while in a running match", () => {
  const { c, h } = lobbyConn({ inMatch: true });
  h.joinLobby(c);
  assert.equal(c.of("joinLobby").length, 0);
  assert.equal(h.lastJoin, 0, "skip must not consume the rate limit");
});

test("joinLobby joins again once the match has ended", () => {
  const { c, h } = lobbyConn({ inMatch: true });
  h.joinLobby(c);
  c.db.matchState.rows[0]!.status = { tag: "Ended" };
  h.joinLobby(c);
  assert.equal(c.of("joinLobby").length, 1);
});

test("joinLobby is skipped when already a member of the open lobby", () => {
  const { c, h } = lobbyConn({ member: true });
  h.joinLobby(c);
  assert.equal(c.of("joinLobby").length, 0);
});

test("joinLobby joins when a member only of a closed lobby", () => {
  const { c, h } = lobbyConn();
  c.db.lobby.rows.push({ id: 6n, status: { tag: "Closed" } });
  c.db.lobbyMember.rows.push({ lobbyId: 6n, botId: ME });
  h.joinLobby(c);
  assert.equal(c.of("joinLobby").length, 1);
});

test("joinLobby still calls joinLobby when no lobby row is visible (server creates one)", () => {
  const { c, h } = lobbyConn({ open: false });
  h.joinLobby(c);
  assert.equal(c.of("joinLobby").length, 1);
});

test("joinLobby is skipped under NO_LOBBY or without a bot id", () => {
  const { c, h } = lobbyConn();
  h.NO_LOBBY = true;
  h.joinLobby(c);
  h.NO_LOBBY = false;
  h.myBotId = null;
  h.joinLobby(c);
  assert.equal(c.of("joinLobby").length, 0);
});

test("joinLobby logs (not warns) when the reducer refuses", async () => {
  const { c, h } = lobbyConn();
  c.manual.add("joinLobby");
  h.joinLobby(c);
  c.pending[0]!.reject(new Error("Already in a match"));
  await flush();
  assert.ok(h.logs.some((l) => l.includes("join lobby refused: Already in a match")));
  assert.equal(h.warnings.length, 0);
});

test("joinLobby ignores other bots' lobby memberships", () => {
  const { c, h } = lobbyConn();
  c.db.lobbyMember.rows.push({ lobbyId: 5n, botId: 99n });
  h.joinLobby(c);
  assert.equal(c.of("joinLobby").length, 1);
});

// ---------- act ordering ----------

test("words are played before bids in act()", () => {
  const { c, h } = seatedMatch({ rack: "CAT" });
  openAuction(c, 1n, "S");
  h.chooseWords = () => ["CAT"];
  h.decideBid = () => ({ bid: 3, value: 1 });
  h.playWords(c);
  h.rebidOpen(c);
  assert.deepEqual(c.calls.map((x) => x.name), ["submitWord", "submitBid"]);
});
