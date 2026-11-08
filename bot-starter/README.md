# NigelR — a ScrabbleBot tournament bot

TypeScript bot for the Spacetime ScrabbleBot tournament (HackUTD 2026).
Confirmed game rules, and where the docs are wrong, are in [RULES.md](RULES.md).

## Run

```bash
cd bot-starter
npm install
npm run generate          # needs the spacetime CLI; bindings are gitignored
BOT_NAME=<name> BOT_TOKEN=<token from /team> npm start   # first run, saves .token-<name>
BOT_NAME=<name> npm start                                 # later runs
BOT_NAME=<name> TOURNAMENT_ID=<id> npm start              # register for a tournament
npm test                                                  # unit tests
```

`NO_LOBBY=1` keeps the bot out of casual lobby matches (useful while
waiting for a tournament to start).

## Layout

- `src/words.ts`: the ENABLE dictionary, an anagram trie over sorted letters,
  `bestWord` and `bestPartition` (branch-and-bound over disjoint words, with a
  node budget). Scoring mirrors the server's integer math exactly. About 1 ms
  on a typical rack and under 20 ms on a 20-tile one.
- `src/ledger.ts`: per-match tile ledger built from public events (auction
  letters, results, word plays). It tracks the unseen pool, each opponent's
  won and played letters, and recent prices.
- `src/brain.ts`: pure decision functions, shared with the simulator.
  - `decideBid`: letter value = max(exact cash-out gain from
    `bestPartition`, future bingo potential from face value × expected
    multiplier × rack fit + flexibility), with the future part fading as the
    bag empties. Coins per point come from **budget pacing**: balance over the
    value still expected to buy, so unspent money (worth 0 at the end) pushes
    bids up on its own. One letter can't take more than 45% of the bankroll
    mid-game. The whole balance goes on the second-to-last letter (if it
    helps) and on the final letter (free denial, since a sim that wins it
    plays it inside the closing transaction).
  - `chooseWords`: play any 7+ word at once (3x is the cap, so waiting gains
    nothing), 6-letter words in the last 10 auctions, cash words when short of
    money or the rack overflows, and cash the full `bestPartition` in the last
    2 auctions.
- `src/index.ts`: networking. Subscriptions are scoped to my credential, my
  rack, the lobby and the current match only (the starter's
  `subscribeToAllTables` runs out of memory on the live database). The bot
  bids one tick after each auction opens and re-bids when its rack or balance
  changes. Every word is checked against the dictionary and the rack before
  it's sent, with an in-flight lock so nothing is submitted twice. Every
  handler is wrapped in try/catch, the bot reconnects with backoff, and it
  logs one line per auction.
- `sim/`: a local match simulator that mirrors `game.ts`, for tuning:
  `npx tsx sim/run.ts --matches 300 --seed 1 --table mixed`.
