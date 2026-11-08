// CLI: npx tsx sim/run.ts --matches 300 --seed 1 --table mixed
//   --table mixed|starters|self|idle|custom   (custom needs --config JSON)
//   --params '{"k":1}'        override the first brain's params
//   --auction Vickrey|FirstPrice|both   (default Vickrey; both = coin flip per match)
//   --brain auto|placeholder  (auto = ../src/brain.ts if it exists)
//   --json                    print a JSON summary instead of the table
//   --check N                 verify fast word search == server scan on N random racks
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuctionType,
  type MatchConfig,
  type PlayerResult,
  type PlayerSpec,
  type Rng,
  type Strategy,
  mulberry32,
  randInt,
  runMatch,
} from "./engine.js";
import type { BrainModule, Params } from "./types.js";
import {
  BAG_COUNTS,
  findBestPlayable,
  findBestPlayableReference,
  wordIndex,
} from "./words.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = "1";
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function loadBrain(which: string): Promise<{ brain: BrainModule; source: string }> {
  const real = resolve(HERE, "../src/brain.ts");
  if (which !== "placeholder" && existsSync(real)) {
    const mod = (await import("../src/brain.js")) as BrainModule;
    return { brain: mod, source: "src/brain.ts" };
  }
  if (which === "real") throw new Error("src/brain.ts not found");
  const mod = (await import("./placeholder.js")) as BrainModule;
  return { brain: mod, source: "sim/placeholder.ts" };
}

const STRATS: Strategy[] = ["Cheapskate", "ValueBidder", "Aggressive"];
const randomSim = (rng: Rng): PlayerSpec => ({
  kind: "sim",
  strategy: STRATS[randInt(rng, 0, 2)]!,
});

function tablePlayers(
  table: string,
  rng: Rng,
  brainParams: Params | undefined,
  defaults: Params,
  custom: PlayerSpec[] | undefined,
): PlayerSpec[] {
  const brain: PlayerSpec = { kind: "brain", label: "brain", params: brainParams ?? defaults };
  switch (table) {
    case "mixed":
      return [brain, ...Array.from({ length: 5 }, () => randomSim(rng))];
    case "starters":
      return [brain, ...Array.from({ length: 5 }, (): PlayerSpec => ({ kind: "starter" }))];
    case "self":
      return [
        brain,
        { kind: "brain", label: "brain-default", params: defaults },
        { kind: "starter" },
        { kind: "starter" },
        randomSim(rng),
        randomSim(rng),
      ];
    case "idle":
      return [
        brain,
        { kind: "idle" },
        { kind: "idle" },
        { kind: "starter" },
        { kind: "starter" },
        { kind: "starter" },
      ];
    case "custom": {
      if (!custom) throw new Error("--table custom needs --config JSON");
      let firstBrainSeen = false;
      return custom.map((p) => {
        if (p.kind === "sim" && (p.strategy as string) === "random") return randomSim(rng);
        if (p.kind !== "brain") return p;
        const params =
          !firstBrainSeen && brainParams ? brainParams : { ...defaults, ...(p.params ?? {}) };
        firstBrainSeen = true;
        return { ...p, label: p.label ?? "brain", params };
      });
    }
    default:
      throw new Error(`unknown table ${table}`);
  }
}

function selfCheck(nRacks: number, seed: number) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const pool: string[] = [];
  BAG_COUNTS.forEach((c, i) => {
    for (let k = 0; k < c; k++) pool.push(String.fromCharCode(65 + i));
  });
  let mismatches = 0;
  for (let t = 0; t < nRacks; t++) {
    const size = randInt(rng, 2, 16);
    const rack = new Map<string, number>();
    const p = pool.slice();
    for (let k = 0; k < size; k++) {
      const j = randInt(rng, 0, p.length - 1);
      const c = p.splice(j, 1)[0]!;
      rack.set(c, (rack.get(c) ?? 0) + 1);
    }
    for (const minLen of [2, 3]) {
      const a = findBestPlayable(rack, minLen);
      const b = findBestPlayableReference(rack, minLen);
      if (a !== b) {
        mismatches++;
        if (mismatches <= 5) console.log("MISMATCH", [...rack], minLen, a, b);
      }
    }
  }
  console.log(`self-check: ${nRacks * 2} searches, ${mismatches} mismatches vs server scan`);
  if (mismatches) process.exitCode = 1;
}

interface Agg {
  label: string;
  n: number;
  scores: number[];
  places: number[];
  rejected: number;
  balance: number;
  leftover: number;
  won: number;
  words: number;
  spent: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const matches = Number(args.matches ?? 300);
  const seed = Number(args.seed ?? 1);
  const table = args.table ?? "mixed";
  const auctionArg = args.auction ?? "Vickrey";

  const t0 = performance.now();
  wordIndex();
  const tIndex = performance.now() - t0;

  if (args.check) {
    selfCheck(Number(args.check), seed);
    if (!args.matches) return;
  }

  const { brain, source } = await loadBrain(args.brain ?? "auto");
  const brainParams: Params | undefined = args.params
    ? { ...brain.DEFAULT_PARAMS, ...(JSON.parse(args.params) as Params) }
    : undefined;
  let custom: PlayerSpec[] | undefined;
  let customAuction: AuctionType | undefined;
  if (args.config) {
    const c = JSON.parse(args.config) as PlayerSpec[] | { players: PlayerSpec[]; auctionType?: AuctionType };
    custom = Array.isArray(c) ? c : c.players;
    if (!Array.isArray(c)) customAuction = c.auctionType;
  }

  const aggs = new Map<string, Agg>();
  let maxPlayers = 0;
  let auctionsTotal = 0;
  const t1 = performance.now();
  for (let m = 0; m < matches; m++) {
    const rng = mulberry32((Math.imul(seed, 1000003) + m * 7919) >>> 0);
    const players = tablePlayers(table, rng, brainParams, brain.DEFAULT_PARAMS, custom);
    const auctionType: AuctionType =
      customAuction ??
      (auctionArg === "both"
        ? rng() < 0.5
          ? "Vickrey"
          : "FirstPrice"
        : (auctionArg as AuctionType));
    const cfg: MatchConfig = { players, auctionType, brain };
    const res = runMatch(cfg, rng);
    auctionsTotal += res.auctions;
    maxPlayers = Math.max(maxPlayers, res.players.length);
    for (const p of res.players as PlayerResult[]) {
      let a = aggs.get(p.label);
      if (!a) {
        a = { label: p.label, n: 0, scores: [], places: [], rejected: 0, balance: 0, leftover: 0, won: 0, words: 0, spent: 0 };
        aggs.set(p.label, a);
      }
      a.n++;
      a.scores.push(p.score);
      a.places.push(p.place);
      a.rejected += p.rejectedWords;
      a.balance += p.balance;
      a.leftover += p.leftoverTiles;
      a.won += p.lettersWon;
      a.words += p.wordsPlayed;
      a.spent += p.spent;
    }
  }
  const tRun = performance.now() - t1;

  const rows = [...aggs.values()].map((a) => {
    const mean = a.scores.reduce((x, y) => x + y, 0) / a.n;
    const std = Math.sqrt(a.scores.reduce((x, y) => x + (y - mean) ** 2, 0) / a.n);
    const placeDist = Array.from({ length: maxPlayers }, (_, k) =>
      (100 * a.places.filter((p) => p === k + 1).length) / a.n,
    );
    return {
      label: a.label,
      seats: a.n,
      avgScore: mean,
      std,
      avgPlace: a.places.reduce((x, y) => x + y, 0) / a.n,
      winPct: placeDist[0]!,
      placeDist,
      avgRejected: a.rejected / a.n,
      avgBalance: a.balance / a.n,
      avgLeftoverTiles: a.leftover / a.n,
      avgLettersWon: a.won / a.n,
      avgWords: a.words / a.n,
      avgSpent: a.spent / a.n,
    };
  });
  rows.sort((x, y) => y.avgScore - x.avgScore);

  const meta = {
    table,
    matches,
    seed,
    auction: customAuction ?? auctionArg,
    brain: source,
    brainParams: brainParams ?? brain.DEFAULT_PARAMS,
    indexMs: Math.round(tIndex),
    msPerMatch: tRun / matches,
    avgAuctions: auctionsTotal / matches,
  };
  if (args.json) {
    console.log(JSON.stringify({ meta, rows }));
    return;
  }
  console.log(
    `table=${table} matches=${matches} seed=${seed} auction=${meta.auction} brain=${source} params=${JSON.stringify(meta.brainParams)}`,
  );
  console.log(
    `index build ${meta.indexMs}ms, ${meta.msPerMatch.toFixed(2)} ms/match, avg ${meta.avgAuctions.toFixed(1)} auctions/match`,
  );
  const f = (x: number, d = 1) => x.toFixed(d);
  const head = [
    "label".padEnd(18),
    "seats".padStart(5),
    "score".padStart(7),
    "std".padStart(6),
    "place".padStart(6),
    "win%".padStart(6),
    ...Array.from({ length: maxPlayers }, (_, k) => `${k + 1}%`.padStart(6)),
    "rej".padStart(5),
    "bal".padStart(6),
    "rack".padStart(5),
    "won".padStart(5),
    "words".padStart(6),
    "spent".padStart(6),
  ].join(" ");
  console.log(head);
  for (const r of rows) {
    console.log(
      [
        r.label.padEnd(18),
        String(r.seats).padStart(5),
        f(r.avgScore).padStart(7),
        f(r.std).padStart(6),
        f(r.avgPlace, 2).padStart(6),
        f(r.winPct).padStart(6),
        ...r.placeDist.map((p) => f(p).padStart(6)),
        f(r.avgRejected, 2).padStart(5),
        f(r.avgBalance).padStart(6),
        f(r.avgLeftoverTiles).padStart(5),
        f(r.avgLettersWon).padStart(5),
        f(r.avgWords).padStart(6),
        f(r.avgSpent).padStart(6),
      ].join(" "),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
