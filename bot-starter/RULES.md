# Confirmed rules (read from source, 2026-11-07)

Sources: `spacetimedb/src/game.ts`, `letters.ts`, `dictionary.ts`, `index.ts`
(reducers), `lobby.ts`, `tournament.ts`. Where the docs disagree, the code wins.

| Rule | Status | Where |
|---|---|---|
| 98 tiles, standard distribution, no blanks, standard values | Confirmed | `letters.ts` `DEFAULT_BAG`, `letterValue` |
| Start balance 100, 5 hidden tiles each (`startingRackSize`, admin-configurable) | Confirmed | `game.ts` `STARTING_BALANCE`, `startMatchWith` |
| One letter per round, sealed bid, `auctionDurationMs` default 1000 | Confirmed | `startMatchWith`, `closeAuction` |
| Bid must be `0 <= amount <= balance`; re-bidding replaces the old bid; bids of 0 ignored at close | Confirmed | `submitBid`, `replaceBid`, `closeAuction` |
| Ties broken randomly (shuffle, then stable sort) | Confirmed | `closeAuction` |
| Vickrey: pay 2nd-highest bid; a lone bidder pays `min(1, bid)` = 1 | Confirmed | `closeAuction` |
| First-price: pay own bid | Confirmed | `closeAuction` |
| Words: >=2 letters, A-Z, in `wordlist.txt` (ENABLE), from your rack | Confirmed | `submitWord`, `playWord` |
| Reward = floor(base x mult): <=3 1x, 4 1.5x, 5 2x, 6 2.5x, 7+ 3x; added to balance AND score | Confirmed | `lengthMultiplier`, `playWord` |
| Ranking is score only; leftover balance/tiles worth 0 | Confirmed | `updateEloAtMatchEnd`, `awardSwissPoints` |
| Match ends at the close that finds the bag empty; `submitWord` then fails ("Match not running") | Confirmed | `closeAuction`, `submitWord` |
| While the last auction is open, `matchState.bagTotal == 0` | Confirmed | `drawLetter` decrements before the auction opens |
| Sim bot bids: Cheapskate v-1, ValueBidder v, Aggressive v+2 / v+4 (vowel), jitter +/-2, min 1, cap balance | Confirmed | `decideBid`, `simulateBids` |
| Sim winner immediately plays its longest word of 3+ letters | Confirmed | `simulateWordPlay` -> `findBestPlayable(rack, 3)` |

## Where the brief (or the docs) is wrong

1. **Unbid letters are discarded, not returned to the bag.** `closeAuction`
   records a result with no winner and draws the next letter; nothing puts the
   tile back. The docs ("Tiles with no bid are returned to the bag") are wrong.
   So with N players there are exactly `98 - 5N` auctions (68 at six seats).
2. **Tournament tables are not padded with sim bots.** `pairIntoMatches` seats
   only registered entrants, at tables of about `matchSize`. Lobby matches are
   padded with sims (`resolveLobby(padWithSims)`). Opponents in the tournament
   are other teams' bots (or offline entrants that never bid).
3. **Auction type in the tournament is whatever the admin chose**
   (`createTournament(auctionType)`); lobby matches are always Vickrey. The bot
   reads `matchState.auctionType` every auction.
4. **The final auction is not "bid 0": bid your whole balance.** Money is
   worthless after the match and a letter won there can't be played, so the
   bid costs nothing. But a *sim* bot that wins it plays a word inside
   `closeAuction` before the match ends, so outbidding it is free denial.
5. **`QI` is not a word here.** ENABLE predates it. Q needs U (QAT, QAID,
   FAQIR, QOPH... are the U-less escapes).
6. **Top bids are archived (and public) only after a match ends**
   (`onMatchEnded`), so price discovery during a match is from `paid` only.
7. **Opponent balances and scores are directly visible** in
   `match_participant`; no need to reconstruct them from events.
8. **Tournament scoring:** Swiss points = `matchSize - place`, where place =
   number of bots with a strictly higher score (ties share the higher place).
   Elimination knocks out last place; ties at last place go to tournament total
   score, then lower bot id.
