// A stand-in for the strong live bots (LexForge, RackMaw, N1gel...), fitted
// to 753 live matches in sim/data/live.json: every letter gets bids, winners
// pay ~10-11 for 1-2 point letters, ~18 for 3-5, ~31-36 for J/Q/X/Z (top bids
// run ~4 higher), about half of their words are 7+ letters, and they finish
// with 11-25 coins unspent. Each rival gets its own personality via params.

import type { BrainModule, MatchView, Params } from "./types.js";
import type { Rng } from "./engine.js";
import { bestPartition, candidates, toCounts, tileCount, VALUES } from "../src/words.js";

export function rivalParams(rng: Rng, i: number): Params {
  const u = () => rng();
  return {
    priceMul: 0.85 + 0.4 * u(), // how far above/below the field's price it bids
    noise: 0.15 + 0.15 * u(),
    pace: 0.9 + 0.5 * u(), // spend-down rate
    heavyLove: 0.7 + 0.6 * u(), // appetite for J/Q/X/Z
    cashRack: 10 + Math.floor(4 * u()), // rack size that forces a play
    endgame: 1 + Math.floor(2 * u()),
    seed: i,
  };
}

// Observed winning-bid levels (top bid) by face value.
function marketPrice(letter: string): number {
  const v = VALUES[letter.charCodeAt(0) - 65] ?? 1;
  if (v >= 8) return 40;
  if (v >= 3) return 22;
  return 14;
}

let noiseState = 12345;
function noise(): number {
  noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
  return noiseState / 4294967296;
}

function decideBid(view: MatchView, letter: string, p: Params = {}): { bid: number; value: number } {
  const bal = Math.floor(view.myBalance);
  if (bal <= 0) return { bid: 0, value: 0 };
  if (view.bagTotal <= 0) return { bid: bal, value: 0 };
  const rack = toCounts(view.myRack);
  const v = VALUES[letter.charCodeAt(0) - 65] ?? 1;
  let price = marketPrice(letter) * (p.priceMul ?? 1);
  if (v >= 8) price *= p.heavyLove ?? 1;
  // Fit: duplicates and vowel glut are worth less.
  const have = rack[letter.charCodeAt(0) - 65] ?? 0;
  if (have >= 2) price *= 0.5;
  else if (have === 1) price *= 0.8;
  // Pace: spend the bankroll over the auctions left.
  const future = view.bagTotal;
  const perAuction = bal / Math.max(1, future * 0.45);
  const k = Math.min(2.5, Math.max(0.5, (perAuction / 14) * (p.pace ?? 1)));
  let bid = price * k * (1 + (p.noise ?? 0.2) * (2 * noise() - 1));
  if (future <= 2) bid = bal;
  else if (future <= 6) bid = Math.max(bid, bal * 0.5);
  bid = Math.floor(Math.max(0, Math.min(bal, bid)));
  if (bid === 0 && bal > 0) bid = 1;
  return { bid, value: price };
}

function chooseWords(view: MatchView, p: Params = {}): string[] {
  const rack = toCounts(view.myRack);
  const n = tileCount(rack);
  if (n < 2) return [];
  if (view.bagTotal <= (p.endgame ?? 2)) return bestPartition(rack).words;
  const cands = candidates(rack);
  if (cands.length === 0) return [];
  const bingo = cands.find((c) => c.len >= 7);
  if (bingo) return [bingo.word];
  if (view.bagTotal <= 8) {
    const six = cands.find((c) => c.len >= 6);
    if (six) return [six.word];
  }
  if (view.myBalance < 10 || n >= (p.cashRack ?? 12)) {
    const w = cands.find((c) => c.len >= 5) ?? cands[0]!;
    return [w.word];
  }
  return [];
}

export const RIVAL: BrainModule = { DEFAULT_PARAMS: {}, decideBid, chooseWords };
