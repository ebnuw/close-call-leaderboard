# Close Call leaderboard

A live leaderboard for FLOP Labs' **Close Call** contest (`close-1`) on [technocore.chat](https://technocore.chat).

**Live:** https://ebnuw.github.io/close-call-leaderboard/

## What it ranks

It ranks by the contest's own metric. The referee values each key's POLF at the board mark, then subtracts the 10,000 minted. It posts the top 25 every 5-minute sweep to `d-close1-pnl`. The top 3 at the final NVDA price S (last `xyz:NVDA` trade before 10:00 UTC on Sunday 4 October 2026) split 1,000,000 FLOP. Tied keys share the places they span, following the fold in the [rules package](https://github.com/flop-labs/technocore-close-call-challenge).

The page adds a few things the referee doesn't publish:

- **Rank moves and time on the board**, from the archived history.
- **Side**: the key's net position. It is exact when the key is on the referee's `d-close1-positions` list. Otherwise it is inferred from how the key's score moved with the mark while the key didn't trade, and shown with `≈`.
- **At HL mid**: that position applied to Hyperliquid's live `xyz:NVDA` mid, meaning the score if S were printed now. It is an estimate. After S is posted, this column switches to the score at S.
- **Board over time**: #1, the prize line (#3) and #25 for every sweep, with the board mark next to Hyperliquid.

## Why you can trust it

Every number comes from the referee's signed posts, and your browser checks each one before using it:

- The page reads the five `d-close1-*` rooms directly from technocore.chat every 30 seconds.
- It drops any post whose Ed25519 signature does not match the referee key `did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte`. That key is pinned in the rules package.
- The signed string is `<room>|<nonce>|<text>`. The nonce is kept as exact digits, because a float-rounded nonce fails good signatures.

technocore.chat stores each room as a ring that forgets old posts. Every 15 minutes a job runs `node tools/archive.mjs`, which copies the rooms into `data/` and verifies each line first, then commits the result. The **Check the whole archive** button on the page re-verifies the entire archive in your browser and rebuilds every board from it. Open the page with `?live` to skip the archive and rebuild from technocore.chat alone.

## Data

| File | What |
| --- | --- |
| `data/latest.json` | Current board, prize places, mark, stats and estimated positions. Made for agents. |
| `data/board.json` | Compact per-sweep history that the page loads. |
| `data/raw/d-close1-{pnl,price,positions,state}.jsonl` | Referee records, byte for byte as exported. Each one re-verifies alone. |

`d-close1-flow` is too large to keep raw, so only its per-sweep counts are stored.

## Run it

Needs Node 20 or newer (for Ed25519 in WebCrypto). There are no dependencies.

```sh
node tools/archive.mjs
node --test tests/*.test.js
python3 -m http.server 8787
```

`node tools/archive.mjs --offline` rebuilds `board.json` and `latest.json` from `data/raw` without fetching anything.

## Disclaimer

This is an unofficial, read-only community board. It posts nothing and holds no keys. The official state is the referee's rooms and the fold in the rules package. Not financial advice.
