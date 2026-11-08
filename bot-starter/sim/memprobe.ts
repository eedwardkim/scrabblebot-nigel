// Memory / latency probe: hammer decideBid + chooseWords with random large racks.
import { decideBid, chooseWords, type MatchView } from "../src/brain.js";
import { BAG } from "../src/words.js";

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);
const letters = Object.entries(BAG).flatMap(([l, n]) => Array(n).fill(l) as string[]);

const rackSize = Number(process.argv[2] ?? 14);
const iters = Number(process.argv[3] ?? 300);
let worst = 0;
let total = 0;
const t0 = performance.now();
for (let it = 0; it < iters; it++) {
  const rack = new Map<string, number>();
  for (let i = 0; i < rackSize; i++) {
    const l = letters[Math.floor(rnd() * letters.length)]!;
    rack.set(l, (rack.get(l) ?? 0) + 1);
  }
  const unseen = new Map<string, number>();
  for (const [l, n] of Object.entries(BAG)) unseen.set(l, Math.max(0, n - (rack.get(l) ?? 0)));
  const view: MatchView = {
    bagTotal: 20 + Math.floor(rnd() * 40),
    auctionType: "Vickrey",
    myBalance: 80,
    myScore: 0,
    myRack: rack,
    unseen,
    opponents: [{ balance: 90, score: 10 }],
    numPlayers: 6,
    avgPaid: 4,
  };
  const letter = letters[Math.floor(rnd() * letters.length)]!;
  const s = performance.now();
  decideBid(view, letter);
  chooseWords(view);
  const ms = performance.now() - s;
  total += ms;
  if (ms > worst) worst = ms;
  if (it % 50 === 49) {
    const m = process.memoryUsage();
    console.log(
      `${it + 1} iters: heap=${(m.heapUsed / 1e6).toFixed(0)}MB rss=${(m.rss / 1e6).toFixed(0)}MB avg=${(total / (it + 1)).toFixed(1)}ms worst=${worst.toFixed(0)}ms`,
    );
  }
}
console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
