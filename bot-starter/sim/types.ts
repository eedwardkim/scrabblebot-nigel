// Local copy of the brain API (bot-starter/src/brain.ts). Kept here so the
// sim compiles and runs before/without brain.ts.
export interface MatchView {
  bagTotal: number;
  auctionType: "Vickrey" | "FirstPrice";
  myBalance: number;
  myScore: number;
  myRack: Map<string, number>;
  unseen: Map<string, number>;
  opponents: { balance: number; score: number }[];
  numPlayers: number;
  // Mean price paid over the last 15 auctions that had a winner (as
  // src/ledger.ts avgPaid computes it); undefined before any.
  avgPaid?: number;
}
export type Params = Record<string, number>;

export interface BrainModule {
  DEFAULT_PARAMS: Params;
  decideBid(view: MatchView, letter: string, params?: Params): { bid: number; value: number };
  chooseWords(view: MatchView, params?: Params): string[];
}
