# node — the ledger node (M1)

A single-sequencer node: it validates signed transactions, batches them into hash-linked
blocks, persists them to an append-only log, and serves a read/write HTTP API. All rule logic
lives in `state.mjs` as a pure reducer; everything else is plumbing.

## Run

```
npm install
npm run node                       # = node node/index.mjs
```

Environment:

| var | default | meaning |
|---|---|---|
| `PORT` | `8645` | HTTP port (binds 127.0.0.1) |
| `DATA_DIR` | `./.data` | holds `genesis.json` and `blocks.jsonl` (gitignored) |
| `BLOCK_INTERVAL_SECONDS` | from `genesis/params.json` (5) | **fresh data dir only** - written into the chain's genesis |
| `VOTING_WINDOW_BLOCKS` | from params (20) | **fresh data dir only** - same |

On first boot the node builds genesis from `genesis/params.json` + `genesis/charter.md`
(env overrides, if any, are applied and frozen into `DATA_DIR/genesis.json`). On every boot it
**rebuilds state by re-executing the whole log from genesis**, checking each block's height,
`prev_hash` and `state_root`. `block_interval_seconds` is read live from chain state, so a
passed `set_param` changes the pace.

Re-verify a data dir independently (separate process, read-only):

```
node node/verify.mjs [DATA_DIR] [MAX_HEIGHT]    # prints {"height","state_root",...}
```

## Files

- `state.mjs` - pure reducer: `applyTx`, `applyBlock`, `executeTxs`, `computeStateRoot`, `blockHash`.
- `store.mjs` - JSONL block log, replay, genesis config.
- `sequencer.mjs` - pending pool, block production, `onBlock(fn)` hook (**M2 anchoring seam**).
- `server.mjs` - HTTP API. `index.mjs` - boot. `verify.mjs` - standalone replayer.

## API

All responses are JSON; reads send `Access-Control-Allow-Origin: *`. Errors are
`{ "error": "<code>", "message": "..." }` (HTTP 4xx).

| method + path | returns |
|---|---|
| `POST /tx` | body = signed tx. `{accepted:true, hash, status:"pending", result}` (`result` is the tentative outcome, e.g. `{proposal_id}`), or an error |
| `GET /health` | `{ok, chain_id, height}` |
| `GET /head` | `{chain_id, height, block_hash, prev_hash, timestamp, state_root}` |
| `GET /state` | the full canonical state object (hash it with canonical JSON to get `state_root`) |
| `GET /params`, `GET /charter` | `state.params`, `state.charter` |
| `GET /identities`, `GET /identities/:id` | identity records (with `agent_id`) |
| `GET /proposals`, `GET /proposals/:id` | proposals with live `tally` (`/:id` also includes `votes`) |
| `GET /blocks?since=<h>` | up to 100 `{hash, block}` with height > `since` (default: from genesis block 0) |
| `GET /block/:height` | `{hash, block}` |
| `GET /tx/:hash` | `{status: pending\|included\|rejected, height?, index?, result?, error?}` (extension to the spec, so clients can wait for inclusion) |

Error codes from `POST /tx`: `bad_format`, `bad_signature`, `bad_nonce`, `unknown_identity`,
`already_registered`, `insufficient_standing`, `invalid_payload`, `unknown_proposal`,
`proposal_closed`, `not_eligible`, `already_voted`, `voting_open`, `tx_too_large`, `duplicate`.

`tx hash` = `blake2b256hex(canonical_json(signed_tx))` (sig included).

## Interpretations of the spec (where it was silent)

See the bottom of `../client/README.md` ("Rules as implemented") - the same list governs the node.
