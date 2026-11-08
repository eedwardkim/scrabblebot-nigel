// Per-match tile ledger built from public events: auction letters, results
// and word plays. Pure data; index.ts feeds it, brain.ts reads unseen().

import { BAG } from "./words.js";

const L = (c: string) => c.charCodeAt(0) - 65;
const zero = () => new Array<number>(26).fill(0);

export class Ledger {
  readonly revealed = zero(); // every letter put up at auction
  readonly won = new Map<string, number[]>(); // botId -> letters won
  readonly played = new Map<string, number[]>(); // botId -> letters played
  readonly paid: number[] = [];
  private auctions = new Set<string>();
  private results = new Set<string>();
  private plays = new Set<string>();

  constructor(readonly matchId: bigint) {}

  private vec(m: Map<string, number[]>, id: string) {
    let v = m.get(id);
    if (!v) m.set(id, (v = zero()));
    return v;
  }

  onAuction(auctionId: bigint, letter: string) {
    const k = String(auctionId);
    if (this.auctions.has(k)) return;
    this.auctions.add(k);
    const i = L(letter);
    if (i >= 0 && i < 26) this.revealed[i]!++;
  }

  onResult(auctionId: bigint, letter: string, winner: bigint | undefined, paid: number) {
    const k = String(auctionId);
    if (this.results.has(k)) return;
    this.results.add(k);
    this.onAuction(auctionId, letter);
    if (winner !== undefined) {
      const i = L(letter);
      if (i >= 0 && i < 26) this.vec(this.won, String(winner))[i]!++;
      this.paid.push(paid);
    }
  }

  onWord(playId: bigint, botId: bigint, word: string) {
    const k = String(playId);
    if (this.plays.has(k)) return;
    this.plays.add(k);
    const v = this.vec(this.played, String(botId));
    for (const c of word) {
      const i = L(c);
      if (i >= 0 && i < 26) v[i]!++;
    }
  }

  avgPaid(lastN = 15): number | undefined {
    const xs = this.paid.slice(-lastN);
    if (xs.length === 0) return undefined;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  // Tiles whose location I don't know: still in the bag, or in an
  // opponent's unrevealed starting rack.
  unseen(myBotId: bigint, myRack: Map<string, number>): Map<string, number> {
    const me = String(myBotId);
    const myWon = this.won.get(me) ?? zero();
    const myPlayed = this.played.get(me) ?? zero();
    const out = new Map<string, number>();
    for (let i = 0; i < 26; i++) {
      const c = String.fromCharCode(65 + i);
      const myStart = Math.max(0, (myRack.get(c) ?? 0) + myPlayed[i]! - myWon[i]!);
      let oppHidden = 0;
      for (const [id, pl] of this.played) {
        if (id === me) continue;
        const w = this.won.get(id)?.[i] ?? 0;
        oppHidden += Math.max(0, pl[i]! - w);
      }
      const n = BAG[c]! - this.revealed[i]! - myStart - oppHidden;
      if (n < 0) {
        console.warn(`[ledger] match ${this.matchId}: unseen ${c} = ${n} (<0), clamping`);
      }
      if (n > 0) out.set(c, n);
    }
    return out;
  }
}
