// Pure match engine mirroring spacetimedb/src/game.ts:
// startMatchWith -> (drawLetter, simulateBids, [bot play window], closeAuction,
// simulateWordPlay)* until the bag is empty.
import type { BrainModule, MatchView, Params } from "./types.js";
import {
  BAG_COUNTS,
  LETTER_VALUE_BY_IDX,
  findBestPlayableCounts,
  isValidWord,
  wordReward,
} from "./words.js";

export type Strategy = "Cheapskate" | "ValueBidder" | "Aggressive";
export type AuctionType = "Vickrey" | "FirstPrice";

export type PlayerSpec =
  | { kind: "sim"; strategy: Strategy; label?: string }
  | { kind: "brain"; params?: Params; label: string }
  | { kind: "starter"; label?: string }
  | { kind: "idle"; label?: string };

export interface MatchConfig {
  players: PlayerSpec[];
  auctionType?: AuctionType; // default Vickrey (lobby default)
  brain?: BrainModule; // required if any player is a brain
  // Called after each auction closes (debugging / cross-checks).
  onClose?: (ev: { letter: string; bids: { who: number; amount: number }[]; winner?: number; paid: number }) => void;
  startingBalance?: number; // 100
  startingRackSize?: number; // 5
}

export interface PlayerResult {
  label: string;
  kind: PlayerSpec["kind"];
  score: number;
  balance: number;
  lettersWon: number;
  spent: number;
  wordsPlayed: number;
  words: string[];
  rejectedWords: number;
  rejectedBids: number;
  leftoverTiles: number;
  place: number;
}

export interface MatchResult {
  auctionType: AuctionType;
  auctions: number;
  players: PlayerResult[];
}

export type Rng = () => number; // uniform [0,1)

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Inclusive integer in [lo, hi].
export function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

const A = 65;
const ch = (i: number) => String.fromCharCode(A + i);
const idxOf = (c: string) => c.charCodeAt(0) - A;
const VOWEL = new Set([0, 4, 8, 14, 20]); // A E I O U

export function labelOf(p: PlayerSpec): string {
  if (p.label) return p.label;
  switch (p.kind) {
    case "sim":
      return `sim:${p.strategy}`;
    case "brain":
      return "brain";
    case "starter":
      return "starter";
    case "idle":
      return "idle";
  }
}

// game.ts decideBid
export function simDecideBid(
  strategy: Strategy,
  li: number,
  balance: number,
  jitter: number,
): number {
  const value = LETTER_VALUE_BY_IDX[li]!;
  let base: number;
  switch (strategy) {
    case "Cheapskate":
      base = value - 1;
      break;
    case "ValueBidder":
      base = value;
      break;
    case "Aggressive":
      base = value + (VOWEL.has(li) ? 4 : 2);
      break;
  }
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

// bot-starter/src/strategy.ts decideBid
function starterBid(li: number, have: number, balance: number): number {
  const value = LETTER_VALUE_BY_IDX[li]!;
  const want = have === 0 ? value + 2 : Math.max(1, value);
  return Math.min(want, Math.max(0, balance));
}

interface PState {
  spec: PlayerSpec;
  label: string;
  balance: number;
  score: number;
  rack: number[];
  startRack: number[];
  won: number[];
  played: number[];
  lettersWon: number;
  spent: number;
  words: string[];
  rejected: number;
  rejectedBids: number;
  starterDirty: boolean;
}

function rackMap(r: number[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < 26; i++) if (r[i]! > 0) m.set(ch(i), r[i]!);
  return m;
}

function applyWord(p: PState, word: string) {
  for (let k = 0; k < word.length; k++) {
    const s = word.charCodeAt(k) - A;
    p.rack[s]!--;
    p.played[s]!++;
  }
  const r = wordReward(word);
  p.balance += r;
  p.score += r;
  p.words.push(word);
}

// Validate like the server's playWord reducer: dictionary word, len>=2,
// ASCII letters, and the current rack holds every letter.
function tryPlay(p: PState, raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const word = raw.replace(/[a-z]/g, (c) => c.toUpperCase());
  if (word.length < 2 || !/^[A-Z]+$/.test(word) || !isValidWord(word)) return false;
  const need = new Array<number>(26).fill(0);
  for (let k = 0; k < word.length; k++) need[word.charCodeAt(k) - A]!++;
  for (let i = 0; i < 26; i++) if (need[i]! > p.rack[i]!) return false;
  applyWord(p, word);
  return true;
}

export function runMatch(config: MatchConfig, rng: Rng): MatchResult {
  const auctionType: AuctionType = config.auctionType ?? "Vickrey";
  const startBal = config.startingBalance ?? 100;
  const rackSize = config.startingRackSize ?? 5;
  const n = config.players.length;
  if (config.players.some((p) => p.kind === "brain") && !config.brain) {
    throw new Error("config.brain is required for brain players");
  }

  const ps: PState[] = config.players.map((spec) => ({
    spec,
    label: labelOf(spec),
    balance: startBal,
    score: 0,
    rack: new Array(26).fill(0),
    startRack: new Array(26).fill(0),
    won: new Array(26).fill(0),
    played: new Array(26).fill(0),
    lettersWon: 0,
    spent: 0,
    words: [],
    rejected: 0,
    rejectedBids: 0,
    starterDirty: true, // starter checks its dealt rack in the first window
  }));

  const bag = BAG_COUNTS.slice();
  let bagTotal = bag.reduce((a, b) => a + b, 0);
  const draw = (): number => {
    if (bagTotal === 0) return -1;
    let idx = randInt(rng, 0, bagTotal - 1);
    for (let i = 0; i < 26; i++) {
      if (idx < bag[i]!) {
        bag[i]!--;
        bagTotal--;
        return i;
      }
      idx -= bag[i]!;
    }
    return -1;
  };

  for (const p of ps) {
    for (let k = 0; k < rackSize; k++) {
      const li = draw();
      if (li < 0) break;
      p.rack[li]!++;
      p.startRack[li]!++;
    }
  }

  const revealed = new Array<number>(26).fill(0);
  // auctionResult.paid for every auction with a winner, in close order
  // (src/ledger.ts pushes these and the live bot passes avgPaid()).
  const paidHistory: number[] = [];
  const avgPaid = (): number | undefined => {
    const xs = paidHistory.slice(-15);
    if (xs.length === 0) return undefined;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };

  const viewFor = (me: number): MatchView => {
    const p = ps[me]!;
    const unseen = new Map<string, number>();
    for (let i = 0; i < 26; i++) {
      let u = BAG_COUNTS[i]! - p.startRack[i]! - revealed[i]!;
      for (let j = 0; j < n; j++) {
        if (j === me) continue;
        const o = ps[j]!;
        u -= Math.max(0, o.played[i]! - o.won[i]!);
      }
      if (u > 0) unseen.set(ch(i), u);
    }
    return {
      bagTotal,
      auctionType,
      myBalance: p.balance,
      myScore: p.score,
      myRack: rackMap(p.rack),
      unseen,
      opponents: ps.filter((_, j) => j !== me).map((o) => ({ balance: o.balance, score: o.score })),
      numPlayers: n,
      avgPaid: avgPaid(),
    };
  };

  let li = draw();
  let auctions = 0;
  while (li >= 0) {
    auctions++;
    revealed[li]!++;
    const letter = ch(li);
    const bids: { who: number; amount: number }[] = [];

    // simulateBids at auction open, with the balance at that moment.
    for (let j = 0; j < n; j++) {
      const p = ps[j]!;
      if (p.spec.kind !== "sim") continue;
      const jitter = randInt(rng, -2, 2);
      const amt = simDecideBid(p.spec.strategy, li, p.balance, jitter);
      if (amt > 0) bids.push({ who: j, amount: amt });
    }

    // Real bots act during the open window.
    for (let j = 0; j < n; j++) {
      const p = ps[j]!;
      const spec = p.spec;
      if (spec.kind === "starter") {
        // The starter (git HEAD src/index.ts) bids once, synchronously in
        // auction.onInsert, so it bids with its rack and balance at the open,
        // before the word it submits this window lands.
        const amt = starterBid(li, p.rack[li]!, p.balance);
        if (amt > 0) bids.push({ who: j, amount: amt });
        // It tries one word per rack change (deal or auction win). The rack
        // change caused by its own word arrives inside the 500ms
        // WORD_RETRY_MS throttle (or is a delete, which it doesn't watch), so
        // it does not try again until it wins another letter.
        if (p.starterDirty) {
          p.starterDirty = false;
          const w = findBestPlayableCounts(p.rack, 2);
          if (w) applyWord(p, w);
        }
      } else if (spec.kind === "brain") {
        const brain = config.brain!;
        // The live bot (src/index.ts playWords) calls chooseWords again each
        // time its submitted words land, until it returns nothing to play.
        for (let round = 0; round < 32; round++) {
          const words = brain.chooseWords(viewFor(j), spec.params);
          if (!Array.isArray(words) || words.length === 0) break;
          let played = 0;
          for (const w of words) {
            if (tryPlay(p, w)) played++;
            else p.rejected++;
          }
          if (played === 0) break;
        }
        const res = brain.decideBid(viewFor(j), letter, spec.params);
        // submitBid takes an i64 and rejects a negative bid or one above the
        // balance; the live bot's BigInt(bid) throws on a fraction or NaN.
        // Any of those means no bid this auction.
        const amt = Number(res?.bid);
        if (!Number.isInteger(amt) || amt < 0 || amt > p.balance) {
          p.rejectedBids++;
        } else if (amt > 0) {
          bids.push({ who: j, amount: amt });
        }
      }
    }

    // closeAuction: shuffle, stable sort desc, Vickrey/FirstPrice.
    for (let i = bids.length - 1; i >= 1; i--) {
      const k = randInt(rng, 0, i);
      [bids[i], bids[k]] = [bids[k]!, bids[i]!];
    }
    bids.sort((a, b) => b.amount - a.amount);
    const [first, second] = bids;
    if (first) {
      const paid =
        auctionType === "FirstPrice"
          ? first.amount
          : second
            ? second.amount
            : Math.min(1, first.amount);
      // auctionResult records winner and paid even if the winner can't pay.
      paidHistory.push(paid);
      const w = ps[first.who]!;
      if (w.balance >= paid) {
        w.balance -= paid;
        w.spent += paid;
        w.rack[li]!++;
        w.won[li]!++;
        w.lettersWon++;
        if (w.spec.kind === "sim") {
          const word = findBestPlayableCounts(w.rack, 3);
          if (word) applyWord(w, word);
        } else if (w.spec.kind === "starter") {
          w.starterDirty = true;
        }
      }
    }
    config.onClose?.({
      letter,
      bids: bids.map((x) => ({ ...x })),
      winner: first?.who,
      paid: first ? (auctionType === "FirstPrice" ? first.amount : second ? second.amount : Math.min(1, first.amount)) : 0,
    });
    // Unbid letters are discarded.
    li = draw();
  }

  const players: PlayerResult[] = ps.map((p) => ({
    label: p.label,
    kind: p.spec.kind,
    score: p.score,
    balance: p.balance,
    lettersWon: p.lettersWon,
    spent: p.spent,
    wordsPlayed: p.words.length,
    words: p.words,
    rejectedWords: p.rejected,
    rejectedBids: p.rejectedBids,
    leftoverTiles: p.rack.reduce((a, b) => a + b, 0),
    place: 1 + ps.filter((o) => o.score > p.score).length,
  }));
  return { auctionType, auctions, players };
}
