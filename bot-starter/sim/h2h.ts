// Head-to-head: npx tsx sim/h2h.ts <brainA.ts> <brainB.ts> [matches] [seed] [seatsA]
// Seats `seatsA` copies of A (default 3) and 6-seatsA copies of B at one
// table and reports each side's average place, win rate and score.
import { resolve } from "node:path";
import { mulberry32, runMatch, type PlayerSpec, type PlayerResult } from "./engine.js";
import type { BrainModule } from "./types.js";

const [a, b, matchesArg, seedArg, seatsArg, auctionArg] = process.argv.slice(2);
if (!a || !b) throw new Error("usage: h2h <A.ts> <B.ts> [matches] [seed] [seatsA] [Vickrey|FirstPrice]");
const matches = Number(matchesArg ?? 200);
const seed = Number(seedArg ?? 1);
const seatsA = Number(seatsArg ?? 3);
const auctionType = (auctionArg as "Vickrey" | "FirstPrice") ?? "Vickrey";
const A = (await import(resolve(process.cwd(), a))) as BrainModule;
const B = (await import(resolve(process.cwd(), b))) as BrainModule;
const rng = mulberry32(seed);
const acc = { A: { n: 0, place: 0, win: 0, score: 0, bal: 0 }, B: { n: 0, place: 0, win: 0, score: 0, bal: 0 } };
const t0 = performance.now();
for (let m = 0; m < matches; m++) {
  const players: PlayerSpec[] = [];
  for (let i = 0; i < 6; i++) {
    const isA = i < seatsA;
    players.push({ kind: "brain", label: isA ? "A" : "B", module: isA ? A : B, params: (isA ? A : B).DEFAULT_PARAMS });
  }
  // Rotate seats so dealing order doesn't favour a side.
  const rot = m % 6;
  const rotated = players.slice(rot).concat(players.slice(0, rot));
  const res = runMatch({ players: rotated, auctionType, brain: A }, rng);
  for (const p of res.players as PlayerResult[]) {
    const side = acc[(p as unknown as { label: string }).label as "A" | "B"];
    side.n++;
    side.place += p.place;
    side.win += p.place === 1 ? 1 : 0;
    side.score += p.score;
    side.bal += p.balance;
  }
}
const ms = (performance.now() - t0) / matches;
for (const [k, s] of Object.entries(acc)) {
  console.log(`${k === "A" ? a : b}: seats=${s.n} place=${(s.place / s.n).toFixed(2)} win%=${((100 * s.win) / s.n).toFixed(1)} score=${(s.score / s.n).toFixed(1)} leftover=${(s.bal / s.n).toFixed(1)}`);
}
console.log(`${matches} matches, ${ms.toFixed(0)} ms/match, auction=${auctionType}`);
