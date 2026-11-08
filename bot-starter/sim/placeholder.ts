// Trivial stand-in brain with the same API as bot-starter/src/brain.ts.
// Used when src/brain.ts does not exist (or with --brain placeholder).
import type { MatchView, Params } from "./types.js";
import { findBestPlayable, letterValue } from "./words.js";

export const DEFAULT_PARAMS: Params = {
  bidMult: 1, // bid = round(value * bidMult) + bidAdd
  bidAdd: 1,
  minLen: 3, // only play words at least this long (while bag is not empty)
  junk: 0, // 1 = also submit an invalid word each window (tests rejection)
};

export function decideBid(
  view: MatchView,
  letter: string,
  params: Params = DEFAULT_PARAMS,
): { bid: number; value: number } {
  const p = { ...DEFAULT_PARAMS, ...params };
  const value = letterValue(letter);
  if (view.bagTotal === 0) return { bid: 0, value: 0 }; // final letter is useless
  const bid = Math.max(0, Math.min(view.myBalance, Math.round(value * p.bidMult!) + p.bidAdd!));
  return { bid, value };
}

export function chooseWords(view: MatchView, params: Params = DEFAULT_PARAMS): string[] {
  const p = { ...DEFAULT_PARAMS, ...params };
  const out: string[] = [];
  if (p.junk) out.push("QZXQZ");
  const rack = new Map(view.myRack);
  const minLen = view.bagTotal === 0 ? 2 : p.minLen!;
  // Greedy: repeatedly take the longest word, removing its letters.
  for (;;) {
    const w = findBestPlayable(rack, minLen);
    if (!w) break;
    out.push(w);
    for (const c of w) rack.set(c, rack.get(c)! - 1);
  }
  return out;
}
