// Decision logic: pure functions over what the bot can see. Shared by the
// live bot (index.ts) and the local simulator (sim/).

import {
  addLetter,
  bestPartition,
  candidates,
  isWord,
  canSpell,
  subtractWord,
  tileCount,
  toCounts,
  countsKey,
  VALUES,
  type Counts,
} from "../../src/words.js";

export interface MatchView {
  bagTotal: number; // matchState.bagTotal while the auction is open (0 = last auction)
  auctionType: "Vickrey" | "FirstPrice";
  myBalance: number;
  myScore: number;
  myRack: Map<string, number>;
  unseen: Map<string, number>; // bag + opponents' unrevealed starting tiles
  opponents: { balance: number; score: number }[];
  numPlayers: number;
  avgPaid?: number; // observed mean price paid at recent auctions
}

export type Params = Record<string, number>;

export const DEFAULT_PARAMS: Params = {
  // Expected length multiplier a kept tile ends up earning.
  mult: 2.6,
  // Scale on the bid relative to estimated score value (Vickrey: ~truthful).
  aggression: 1.0,
  // Budget pacing: share of future letter value we expect to buy, and
  // clamps on the coins-per-point exchange rate.
  share: 0.35,
  kMin: 1.2,
  kMax: 8,
  maxFrac: 0.45,
  // Spend-down ramp over the last rampN auctions (leftover coins score 0).
  rampN: 12,
  rampPow: 1.0,
  // Letter valuation tweaks (from letters variant).
  flexScale: 1.0,
  heavyCap: 2.0,
  midCap: 2.4,
  // FirstPrice: cap bid at maxRival+1 and floor at an estimated rival bid.
  fpFrac: 0.5,
  // Flat premium for any tile (denial / price-setting).
  floor: 1,
  // Cash out everything once this many auctions or fewer remain.
  endgame: 2,
  // Play a 6-letter word once this few auctions remain.
  sixLate: 10,
  // Balance below which we cash words to keep bidding.
  lowCash: 12,
  // Rack size at which we force a play.
  maxRack: 13,
  // Target fraction of vowels in the rack.
  vowelTarget: 0.42,
  // Monte-Carlo expected-gain valuation.
  mcN: 16,
  mcKFrac: 0.2,
  mcKMax: 4,
  mcBudget: 4000,
  evW: 1.0,
  potW: 0.5,
};

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
// Draws of k letters from unseen (without replacement), cached by rack+k.
interface Draws { racks: Counts[]; base: number[] }
const drawCache = new Map<string, Draws>();
function getDraws(rack: Counts, unseen: Map<string, number>, k: number, p: Params): Draws {
  const key = countsKey(rack) + "|" + k;
  const hit = drawCache.get(key);
  if (hit) return hit;
  const pool: number[] = [];
  for (const [l, n] of unseen) {
    const i = l.charCodeAt(0) - 65;
    if (i < 0 || i >= 26) continue;
    for (let j = 0; j < n; j++) pool.push(i);
  }
  const rnd = mulberry32(hashStr(key));
  const racks: Counts[] = [];
  const base: number[] = [];
  const N = Math.round(p.mcN!);
  for (let s = 0; s < N; s++) {
    const r = rack.slice();
    // partial Fisher-Yates on a copy of indices
    const m = Math.min(k, pool.length);
    const used = new Set<number>();
    for (let d = 0; d < m; d++) {
      let idx = Math.floor(rnd() * pool.length);
      let tries = 0;
      while (used.has(idx) && tries++ < 20) idx = Math.floor(rnd() * pool.length);
      used.add(idx);
      r[pool[idx]!]!++;
    }
    racks.push(r);
    base.push(bestPartition(r, p.mcBudget!).total);
  }
  if (drawCache.size > 5000) drawCache.clear();
  const out = { racks, base };
  drawCache.set(key, out);
  return out;
}
function evGain(view: MatchView, rack: Counts, i: number, future: number, p: Params): number {
  const k = Math.min(p.mcKMax!, Math.round(future * p.mcKFrac!));
  if (k <= 0) return 0;
  const d = getDraws(rack, view.unseen, k, p);
  let sum = 0;
  for (let s = 0; s < d.racks.length; s++) {
    const r = d.racks[s]!.slice();
    r[i]!++;
    sum += Math.max(0, bestPartition(r, p.mcBudget!).total - d.base[s]!);
  }
  return d.racks.length ? sum / d.racks.length : 0;
}

const VOWELS = new Set([0, 4, 8, 14, 20]); // A E I O U

function vowelCount(c: Counts): number {
  return c[0]! + c[4]! + c[8]! + c[14]! + c[20]!;
}

// How well a tile fits the rack for building 7+ letter words, 0..1.2.
function fit(c: Counts, i: number, p: Params): number {
  const n = tileCount(c) + 1;
  const v = vowelCount(c) + (VOWELS.has(i) ? 1 : 0);
  const ratio = v / n;
  let f = 1;
  if (VOWELS.has(i)) {
    if (ratio > p.vowelTarget! + 0.15) f *= 0.35;
    else if (ratio < p.vowelTarget!) f *= 1.2;
  } else {
    if (ratio < p.vowelTarget! - 0.2) f *= 0.45;
    else if (ratio > p.vowelTarget! + 0.1) f *= 1.15;
  }
  const have = c[i]!;
  const dupOk = i === 4 || i === 18; // E, S tolerate duplicates
  if (have === 1) f *= dupOk ? 0.95 : 0.75;
  else if (have >= 2) f *= dupOk ? 0.6 : 0.3;
  // Q without U is nearly dead in ENABLE (no QI): QAT, QAID, QOPH, FAQIR...
  if (i === 16 && c[20]! === 0) f *= 0.45;
  if (i === 20 && c[16]! > 0 && c[20]! === 0) f *= 1.6;
  return f;
}

// Multiplier a letter realistically earns (heavy tiles rarely fit 7+ words).
function letterMult(i: number, p: Params): number {
  const v = VALUES[i]!;
  if (v >= 8) return Math.min(p.mult!, p.heavyCap!);
  if (v >= 4) return Math.min(p.mult!, p.midCap!);
  return p.mult!;
}

// Synergy bonus for letters that make long words easy.
const FLEX: Record<number, number> = {
  18: 2.5, // S
  4: 1.5, // E
  17: 1, // R
  0: 0.8, // A
  8: 0.8, // I
  13: 0.8, // N
  19: 0.8, // T
  11: 0.5, // L
  3: 0.5, // D
  6: 0.4, // G
  14: 0.4, // O
};

export function letterValue(view: MatchView, letter: string, p: Params = DEFAULT_PARAMS): number {
  const i = letter.charCodeAt(0) - 65;
  if (i < 0 || i >= 26) return 0;
  // The final auction closes the match: nothing won there can be played.
  if (view.bagTotal <= 0) return 0;
  const rack = toCounts(view.myRack);
  const before = bestPartition(rack).total;
  const after = bestPartition(addLetter(rack, letter)).total;
  const nowGain = Math.max(0, after - before);
  // Auctions after this one whose letters we could still play.
  const future = view.bagTotal - 1;
  if (future <= 0) return nowGain;
  const potential = (VALUES[i]! * letterMult(i, p) + (FLEX[i] ?? 0) * p.flexScale!) * fit(rack, i, p);
  // Option value fades as the match runs out of letters to build with.
  const w = Math.min(1, future / 12);
  const ev = evGain(view, rack, i, future, p);
  const opt = p.evW! * ev + p.potW! * potential;
  return Math.max(nowGain, w * opt + (1 - w) * nowGain);
}

export function decideBid(
  view: MatchView,
  letter: string,
  p: Params = DEFAULT_PARAMS,
): { bid: number; value: number } {
  const bal = Math.max(0, Math.floor(view.myBalance));
  if (bal <= 0) return { bid: 0, value: 0 };
  // Money is worth nothing once the match ends, and a sim bot that wins the
  // final letter still plays it inside the closing transaction. Bidding our
  // whole balance there is free denial.
  if (view.bagTotal <= 0) return { bid: bal, value: 0 };
  const value = letterValue(view, letter, p);
  const future = view.bagTotal - 1;
  // Budget pacing. Unspent money scores nothing, so the exchange rate
  // between score and coins is what we hold over the value we still expect
  // to buy. Not winning makes balance pile up and bids rise on their own.
  const price = Math.max(2, view.avgPaid ?? 4);
  const wanted = Math.max(5, (future + 1) * 3 * p.share!);
  const k = Math.min(p.kMax!, Math.max(p.kMin!, bal / wanted));
  let bid = value * p.aggression! * k + (value > 0 ? p.floor! : 0);
  // Don't let one mid-game letter eat the bankroll.
  if (future > 5) bid = Math.min(bid, bal * p.maxFrac!);
  if (future <= 0 && value > 0) bid = bal; // second-to-last: money is about to be worthless
  else if (future <= 3 && value > 0) bid = Math.max(bid, Math.min(bal, value * 3));
  if (value > 0 && future < p.rampN!) {
    const f = Math.pow(1 - future / p.rampN!, p.rampPow!);
    bid = Math.max(bid, bal * f);
  }
  if (view.auctionType === "FirstPrice") {
    // Pay-your-bid: shade to just above an estimated rival bid, never above
    // what the richest rival could pay.
    const rivals = view.opponents.map((o) => Math.max(0, Math.floor(o.balance)));
    const maxRival = rivals.length ? Math.max(...rivals) : 0;
    const sorted = rivals.slice().sort((a, b) => b - a);
    const second = sorted[1] ?? 0;
    const est = Math.min(second, Math.max(price, maxRival * p.fpFrac! * (value / Math.max(1, value + 4))));
    bid = Math.min(bid, Math.max(est + 1, price + 1, bid * 0.6));
    bid = Math.min(bid, maxRival + 1);
  }
  bid = Math.floor(Math.max(0, Math.min(bal, bid)));
  return { bid, value };
}

// Words to submit now. Disjoint and spellable together from the rack.
export function chooseWords(view: MatchView, p: Params = DEFAULT_PARAMS): string[] {
  const rack = toCounts(view.myRack);
  const n = tileCount(rack);
  if (n < 2) return [];
  const left = view.bagTotal; // auctions still to close after the open one
  // Endgame: cash everything.
  if (left <= p.endgame!) return validate(bestPartition(rack).words, rack);

  const cands = candidates(rack);
  if (cands.length === 0) return [];
  // A 7+ word locks the top multiplier; an extra letter in it is worth no
  // more than the same letter in the next bingo, so play it now. Prefer the
  // one whose leave still partitions best.
  const bingos = cands.filter((c) => c.len >= 7).slice(0, 12);
  if (bingos.length > 0) {
    let best = bingos[0]!;
    let bestScore = -1;
    for (const b of bingos) {
      const leave = subtractWord(rack, b.word);
      const s = b.reward + 0.3 * bestPartition(leave, 4000).total;
      if (s > bestScore) {
        bestScore = s;
        best = b;
      }
    }
    return validate([best.word], rack);
  }
  if (left <= p.sixLate!) {
    const six = cands.find((c) => c.len === 6);
    if (six) return validate([six.word], rack);
  }
  // Short of cash or rack overflowing: play the best word, at least 4 long
  // if possible.
  if (view.myBalance < p.lowCash! || n >= p.maxRack!) {
    const w = cands.find((c) => c.len >= 4) ?? cands[0]!;
    return validate([w.word], rack);
  }
  return [];
}

function validate(words: string[], rack: Counts): string[] {
  let r = rack.slice();
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 2 || !isWord(w) || !canSpell(w, r)) continue;
    r = subtractWord(r, w);
    out.push(w);
  }
  return out;
}
