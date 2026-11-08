// ScrabbleBot — Nigel edition.
//
//   BOT_NAME=<name> BOT_TOKEN=<token> npm start       (first run)
//   BOT_NAME=<name> npm start                         (token saved in .token-<name>)
//   BOT_NAME=<name> TOURNAMENT_ID=<id> npm start      (register for a tournament)
//
// Strategy lives in brain.ts (bids, word timing) and words.ts (dictionary).

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { chooseWords, decideBid, type MatchView } from "./brain.js";
import { Ledger } from "./ledger.js";
import { canSpell, isWord, subtractWord, toCounts, wordReward } from "./words.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const NO_LOBBY = process.env.NO_LOBBY === "1";
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}] [${BOT_NAME}]`, ...a);
const warn = (...a: unknown[]) => console.warn(`[${new Date().toISOString().slice(11, 23)}] [${BOT_NAME}] WARN`, ...a);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  try {
    fs.writeFileSync(TOKEN_PATH, tok);
  } catch (e) {
    warn("could not save token", e);
  }
}

let conn: DbConnection | null = null;
let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let registered = false;

const ledgers = new Map<string, Ledger>();
// auctionId -> what we last bid and valued
const myBids = new Map<string, { bid: number; value: number; bagTotal: number }>();
const inflightWords = new Map<string, number>(); // matchId -> reducer calls in flight
const rejectedStreak = new Map<string, number>();

function safe<T extends unknown[]>(name: string, fn: (...a: T) => void) {
  return (...a: T) => {
    try {
      fn(...a);
    } catch (e) {
      warn(`${name} threw:`, e instanceof Error ? e.stack : e);
    }
  };
}

function ledgerFor(matchId: bigint): Ledger {
  const k = String(matchId);
  let l = ledgers.get(k);
  if (!l) ledgers.set(k, (l = new Ledger(matchId)));
  return l;
}

function resolveMyBotId(c: DbConnection): bigint | null {
  if (!myIdentity) return null;
  return c.db.botCredential.identity.find(myIdentity)?.botId ?? null;
}

function rackFor(c: DbConnection, matchId: bigint): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of c.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function myMatches(c: DbConnection): bigint[] {
  const out: bigint[] = [];
  if (myBotId === null) return out;
  for (const p of c.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = c.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") out.push(p.matchId);
  }
  return out;
}

function buildView(c: DbConnection, matchId: bigint): MatchView | null {
  if (myBotId === null) return null;
  const m = c.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") return null;
  let me: { balance: number; score: number } | null = null;
  const opponents: { balance: number; score: number }[] = [];
  for (const p of c.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    const row = { balance: Number(p.balance), score: Number(p.score) };
    if (p.botId === myBotId) me = row;
    else opponents.push(row);
  }
  if (!me) return null;
  const rack = rackFor(c, matchId);
  const led = ledgerFor(matchId);
  return {
    bagTotal: m.bagTotal,
    auctionType: m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey",
    myBalance: me.balance,
    myScore: me.score,
    myRack: rack,
    unseen: led.unseen(myBotId, rack),
    opponents,
    numPlayers: opponents.length + 1,
    avgPaid: led.avgPaid(),
  };
}

// ---------- Bidding ----------

function bidOn(c: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  if (myBotId === null) return;
  const a = c.db.auction.id.find(auctionId);
  if (!a || a.status.tag !== "Open") return;
  const view = buildView(c, matchId);
  if (!view) return;
  const t0 = performance.now();
  const { bid, value } = decideBid(view, letter);
  const ms = performance.now() - t0;
  const k = String(auctionId);
  const prev = myBids.get(k);
  if (prev && prev.bid === bid) return;
  if (!prev && bid <= 0) {
    myBids.set(k, { bid: 0, value, bagTotal: view.bagTotal });
    return;
  }
  myBids.set(k, { bid, value, bagTotal: view.bagTotal });
  if (ms > 50) warn(`slow decideBid ${ms.toFixed(0)}ms`);
  c.reducers
    .submitBid({ auctionId, amount: BigInt(bid) })
    .catch((e: unknown) => warn(`bid ${bid} on '${letter}' (auction ${auctionId}) failed: ${e instanceof Error ? e.message : e}`));
}

function rebidOpen(c: DbConnection) {
  for (const a of c.db.auction.iter()) {
    if (a.status.tag !== "Open") continue;
    if (!myMatches(c).some((m) => m === a.matchId)) continue;
    bidOn(c, a.id, a.matchId, a.letter);
  }
}

// ---------- Words ----------

function playWords(c: DbConnection) {
  if (myBotId === null) return;
  for (const matchId of myMatches(c)) {
    const mk = String(matchId);
    if ((inflightWords.get(mk) ?? 0) > 0) continue;
    const view = buildView(c, matchId);
    if (!view) continue;
    const words = chooseWords(view);
    if (words.length === 0) continue;
    // Final check against the dictionary and the current rack.
    let rack = toCounts(view.myRack);
    const ok: string[] = [];
    for (const w of words) {
      if (!isWord(w) || !canSpell(w, rack)) {
        warn(`refusing '${w}': not spellable/valid`);
        continue;
      }
      rack = subtractWord(rack, w);
      ok.push(w);
    }
    if (ok.length === 0) continue;
    inflightWords.set(mk, ok.length);
    for (const word of ok) {
      log(`match ${matchId} bag=${view.bagTotal}: playing '${word}' (+${wordReward(word)})`);
      c.reducers
        .submitWord({ matchId, word })
        .then(() => rejectedStreak.set(mk, 0))
        .catch((e: unknown) => {
          warn(`word '${word}' rejected: ${e instanceof Error ? e.message : e}`);
          rejectedStreak.set(mk, (rejectedStreak.get(mk) ?? 0) + 1);
        })
        .finally(() => {
          inflightWords.set(mk, Math.max(0, (inflightWords.get(mk) ?? 1) - 1));
          if ((inflightWords.get(mk) ?? 0) === 0 && (rejectedStreak.get(mk) ?? 0) < 5) {
            setImmediate(safe("playWords", () => conn && playWords(conn)));
          }
        });
    }
  }
}

// Words first (they raise our balance), then bids.
function act(c: DbConnection) {
  playWords(c);
  rebidOpen(c);
}

// ---------- Lobby / tournament ----------

let lastJoin = 0;
function joinLobby(c: DbConnection) {
  if (myBotId === null || NO_LOBBY) return;
  if (myMatches(c).length > 0) return;
  if (Date.now() - lastJoin < 3000) return;
  const openLobby = Array.from(c.db.lobby.iter()).find((l) => l.status.tag === "Open");
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(c.db.lobbyMember.iter()).some((lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId);
  if (alreadyIn) return;
  lastJoin = Date.now();
  log("joining lobby");
  c.reducers.joinLobby({}).catch((e: unknown) => log(`join lobby refused: ${e instanceof Error ? e.message : e}`));
}

function bootstrap(c: DbConnection) {
  if (TOURNAMENT_ID && !registered) {
    c.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() => {
        registered = true;
        log(`registered for tournament ${TOURNAMENT_ID}`);
      })
      .catch((e: unknown) => warn(`register for tournament ${TOURNAMENT_ID}: ${e instanceof Error ? e.message : e}`));
  }
  // Rebuild ledgers for running matches from the cache.
  const running = new Set(myMatches(c).map(String));
  for (const a of c.db.auction.iter()) if (running.has(String(a.matchId))) ledgerFor(a.matchId).onAuction(a.id, a.letter);
  for (const r of c.db.auctionResult.iter())
    if (running.has(String(r.matchId))) ledgerFor(r.matchId).onResult(r.auctionId, r.letter, r.winnerBotId ?? undefined, Number(r.paid));
  for (const w of c.db.wordPlay.iter()) if (running.has(String(w.matchId))) ledgerFor(w.matchId).onWord(w.id, w.botId, w.word);
  joinLobby(c);
  act(c);
}

// Phase 2: my seats and match states.
function subscribeMine(c: DbConnection) {
  if (myBotId === null) return;
  c.subscriptionBuilder()
    .onApplied(safe("mine applied", () => {
      // My most recent seat may be a match still running (reconnect).
      let latest: bigint | null = null;
      for (const p of c.db.matchParticipant.iter())
        if (p.botId === myBotId && (latest === null || p.matchId > latest)) latest = p.matchId;
      log(`subscribed to my seats (latest match ${latest ?? "-"})`);
      if (latest !== null) subscribeMatch(c, latest);
      bootstrap(c);
    }))
    .onError((_ctx: unknown, e?: unknown) => warn("my-matches subscription error", e))
    .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`]);
}

// Phase 3: one match's public events, only while I'm seated in it.
const matchSubs = new Map<string, { unsubscribe: () => void }>();
function subscribeMatch(c: DbConnection, matchId: bigint) {
  const k = String(matchId);
  if (matchSubs.has(k)) return;
  ledgerFor(matchId);
  const handle = c.subscriptionBuilder()
    .onApplied(safe("match applied", () => {
      const led = ledgerFor(matchId);
      for (const a of c.db.auction.iter()) if (a.matchId === matchId) led.onAuction(a.id, a.letter);
      for (const r of c.db.auctionResult.iter())
        if (r.matchId === matchId) led.onResult(r.auctionId, r.letter, r.winnerBotId ?? undefined, Number(r.paid));
      for (const w of c.db.wordPlay.iter()) if (w.matchId === matchId) led.onWord(w.id, w.botId, w.word);
      const st = c.db.matchState.id.find(matchId)?.status.tag;
      log(`subscribed to match ${matchId} (${st})`);
      if (st !== "Running") {
        unsubscribeMatch(matchId);
        ledgers.delete(k);
        joinLobby(c);
        return;
      }
      act(c);
    }))
    .onError((_ctx: unknown, e?: unknown) => warn(`match ${matchId} subscription error`, e))
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${matchId}`,
      `SELECT * FROM match_participant WHERE match_id = ${matchId}`,
      `SELECT * FROM auction WHERE match_id = ${matchId}`,
      `SELECT * FROM auction_result WHERE match_id = ${matchId}`,
      `SELECT * FROM word_play WHERE match_id = ${matchId}`,
    ]);
  matchSubs.set(k, handle as unknown as { unsubscribe: () => void });
}
function unsubscribeMatch(matchId: bigint) {
  const k = String(matchId);
  const h = matchSubs.get(k);
  matchSubs.delete(k);
  try {
    h?.unsubscribe();
  } catch (e) {
    warn("unsubscribe failed", e);
  }
}

function isRunning(c: DbConnection, matchId: bigint) {
  return c.db.matchState.id.find(matchId)?.status.tag === "Running";
}

function onConnect(c: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  reconnectDelay = 1000;
  log(`connected as ${identity.toHexString()}`);

  c.subscriptionBuilder()
    .onApplied(
      safe("onApplied", () => {
        myBotId = resolveMyBotId(c);
        if (myBotId === null) {
          if (BOT_NONCE) {
            c.reducers.claimCredential({ code: BOT_NONCE }).catch((e: unknown) => warn("claim failed", e));
            setTimeout(
              safe("claim", () => {
                myBotId = resolveMyBotId(c);
                if (myBotId === null) {
                  console.error("couldn't claim credential. Bad / expired nonce?");
                  process.exit(1);
                }
                bootstrap(c);
              }),
              1500,
            );
            return;
          }
          console.error("no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE.");
          process.exit(1);
        }
        log(`acting as bot '${c.db.bot.id.find(myBotId)?.name ?? "?"}' (id ${myBotId})`);
        subscribeMine(c);
      }),
    )
    .onError((_ctx: unknown, e?: unknown) => warn("base subscription error", e))
    // Never subscribeToAllTables: the full match history is gigabytes.
    .subscribe([
      "SELECT * FROM bot_credential",
      "SELECT * FROM bot",
      "SELECT * FROM lobby",
      "SELECT * FROM lobby_member",
      "SELECT * FROM my_rack",
    ]);

  c.db.auction.onInsert(
    safe("auction.onInsert", (_ctx: EventContext, a) => {
      if (!isRunning(c, a.matchId)) return;
      ledgerFor(a.matchId).onAuction(a.id, a.letter);
      if (a.status.tag !== "Open") return;
      // Defer one tick so the rest of this transaction (rack, balance,
      // bagTotal) is in the cache.
      setImmediate(
        safe("bid", () => {
          bidOn(c, a.id, a.matchId, a.letter);
          playWords(c);
        }),
      );
    }),
  );
  c.db.auctionResult.onInsert(
    safe("auctionResult.onInsert", (_ctx: EventContext, r) => {
      const led = ledgers.get(String(r.matchId));
      if (!led) return;
      led.onResult(r.auctionId, r.letter, r.winnerBotId ?? undefined, Number(r.paid));
      const mine = myBids.get(String(r.auctionId));
      const winner = r.winnerBotId ?? undefined;
      const tag = winner === undefined ? "nobody" : winner === myBotId ? "ME" : `bot ${winner}`;
      log(
        `auction m${r.matchId}#${r.auctionId} '${r.letter}' value=${mine ? mine.value.toFixed(1) : "-"} bid=${mine?.bid ?? 0} ` +
          `winner=${tag} paid=${r.paid} bag=${mine?.bagTotal ?? "?"}`,
      );
      myBids.delete(String(r.auctionId));
    }),
  );
  c.db.wordPlay.onInsert(
    safe("wordPlay.onInsert", (_ctx: EventContext, w) => {
      const led = ledgers.get(String(w.matchId));
      if (led) led.onWord(w.id, w.botId, w.word);
    }),
  );
  const rackChanged = safe("rack", () => setImmediate(safe("act", () => act(c))));
  c.db.myRack.onInsert(rackChanged);
  c.db.myRack.onUpdate(rackChanged);
  c.db.botCredential.onInsert(
    safe("cred", () => {
      if (myBotId === null) myBotId = resolveMyBotId(c);
    }),
  );
  c.db.matchParticipant.onInsert(
    safe("mp.onInsert", (_ctx: EventContext, p) => {
      if (p.botId === myBotId) {
        log(`seated in match ${p.matchId}`);
        subscribeMatch(c, p.matchId);
      }
    }),
  );
  c.db.matchState.onUpdate(
    safe("ms.onUpdate", (_ctx: EventContext, old, neu) => {
      if (myBotId === null) return;
      if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
        const parts = Array.from(c.db.matchParticipant.iter()).filter((p) => p.matchId === neu.id);
        const me = parts.find((p) => p.botId === myBotId);
        if (!me) return;
        const place = 1 + parts.filter((p) => p.score > me.score).length;
        const left = rackFor(c, neu.id);
        log(
          `MATCH ${neu.id} ENDED place=${place}/${parts.length} score=${me.score} balance=${me.balance} ` +
            `leftover=${[...left].map(([k, v]) => k.repeat(v)).join("")} scores=[${parts.map((p) => p.score).sort((a, b) => Number(b - a)).join(",")}]`,
        );
        ledgers.delete(String(neu.id));
        setTimeout(safe("unsub", () => unsubscribeMatch(neu.id)), 2000);
        setTimeout(safe("rejoin", () => joinLobby(c)), 250);
      }
    }),
  );
  c.db.lobby.onInsert(safe("lobby", () => joinLobby(c)));
}

let reconnectDelay = 1000;
let reconnectTimer: NodeJS.Timeout | null = null;
function scheduleReconnect(why: string) {
  if (reconnectTimer) return;
  warn(`${why}; reconnecting in ${reconnectDelay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(10_000, reconnectDelay * 2);
}

function connect() {
  log(`connecting to ${DB_NAME} at ${HOST}`);
  try {
    conn = DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .withToken(BOT_TOKEN ?? loadToken())
      .onConnect((c, id, tok) => {
        try {
          onConnect(c, id, tok);
        } catch (e) {
          warn("onConnect threw", e);
        }
      })
      .onConnectError((_ctx: ErrorContext, err: Error) => scheduleReconnect(`connect error: ${err.message}`))
      .onDisconnect(() => scheduleReconnect("disconnected"))
      .build();
  } catch (e) {
    scheduleReconnect(`build threw: ${e instanceof Error ? e.message : e}`);
  }
}

process.on("uncaughtException", (e) => warn("uncaughtException", e));
process.on("unhandledRejection", (e) => warn("unhandledRejection", e));

connect();
