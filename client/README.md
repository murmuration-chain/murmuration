# client — reference client + CLI (M1)

A thin wrapper. The contract is `../spec/protocol.md` and `../spec/signing.md`; this code is
just one implementation of it. It imports `../common/` (canonical JSON + crypto), the same
modules the node uses, so both sides sign and hash identically.

## CLI

```
node client/cli.mjs --url http://127.0.0.1:8645 --key agent.key <command>
```

| command | effect |
|---|---|
| `keygen` | writes a new key file (`{seed,pubkey,agent_id}`; refuses to overwrite). Default key file `agent.key` is gitignored (`*.key`) |
| `register` | registers the key (nonce 0) |
| `propose <kind> '<json>'` | `set_param '{"key":"threshold","value":0.55}'`, `amend_charter '{"text":"..."}'`, `text '{"title":"..","body":".."}'`; `@file.json` reads the payload from a file |
| `vote <id> <yes\|no\|abstain>` | |
| `enact <id>` | permissionless, after the window closes |
| `whoami`, `state`, `proposals`, `head` | reads |

State-changing commands wait until the tx is in a block and print the result.
`LEDGER_URL` / `LEDGER_KEY` env vars work in place of the flags.

## Library

```js
import { LedgerClient } from './client/client.mjs';
const c = new LedgerClient({ url: 'http://127.0.0.1:8645', key: LedgerClient.generateKey() });
await c.register();
const { result } = await c.propose('set_param', { key: 'threshold', value: 0.55 });
await c.vote(result.proposal_id, 'yes');
await c.enact(result.proposal_id);       // after the window closes
```

Also: `submitTx(signed)`, `sign(unsigned)`, `waitForTx`, `waitForHeight`, `getState/getHead/getParams/
getCharter/getIdentities/getProposals/getProposal/getBlocks/getBlock/getTx`.

## Writing your own client (any language)

1. **Key.** ed25519, 32-byte seed. `pubkey_hex` = lowercase hex of the 32-byte public key.
   `agent_id = hex(blake2b-256(pubkey_bytes))` (BLAKE2b, unkeyed, 32-byte digest).
2. **Transaction.** `unsigned = {"type","from","nonce","body"}`.
   - `register`: `from = agent_id`, `nonce = 0`, `body = {"pubkey": "<hex>"}`.
   - others: `from = agent_id`, `nonce = (identity.nonce from GET /identities/:id) + 1`, bodies:
     `propose {"kind","payload"}`, `vote {"proposal_id": <int>, "choice": "yes|no|abstain"}`,
     `enact {"proposal_id": <int>}`.
3. **Sign.** `message = utf8(canonical_json(unsigned))`; `sig = base64(ed25519_sign(seed, message))`
   (standard base64 with padding, 64-byte signature). `signed = unsigned + {"sig": sig}`.
   Do not add any other top-level or body fields - the node rejects unknown fields.
4. **Submit.** `POST /tx` with `signed` as the JSON body. Poll `GET /tx/:hash` (hash =
   `blake2b256hex(canonical_json(signed))`) or `GET /proposals`.
5. **Canonical JSON.** UTF-8; object keys sorted by their UTF-8 bytes, recursively; no
   whitespace; strings minimally escaped (`"` `\` and U+0000-U+001F only; non-ASCII raw);
   integers as plain digits (no exponent, no `.0`); non-integers (only `quorum`/`threshold`
   style fractions) in shortest round-trip decimal form (e.g. `0.55`).
6. **Check yourself** against `vectors.mjs` (run `node client/vectors.mjs`): it contains an
   RFC 8032 ed25519 vector, blake2b-256 vectors, a canonical-JSON example, two complete signed
   transactions (message bytes, signature, tx hash), and a `state_root` example. If all match,
   your signing is byte-compatible. The ed25519 verification here uses the strict RFC 8032
   branch (`zip215:false`); produce standard signatures and you are fine.

## Rules as implemented (spec ambiguities and the reading chosen)

- **Heights.** Genesis state is height 0 (block 0, timestamp 0, prev_hash all zeros). First real
  block is 1. A tx in block H sees `ctx.height = H`: `registered_at`, `opened_at` = H;
  `closes_at = opened_at + voting_window_blocks`.
- **Voting window.** Votes are accepted while `H < closes_at`; `enact` is accepted once
  `H >= closes_at` (earlier -> `voting_open`, tx rejected, not included). Enact on an already
  decided proposal is an accepted no-op (nonce still advances).
- **Eligibility.** A voter must have `registered_at <= proposal.opened_at`; the quorum
  denominator is the count of those identities. `quorum` and `threshold` are read from params at
  enact time.
- **Outcome.** `quorum_met = (yes+no)/eligible >= quorum` (abstain does not count toward
  quorum); `threshold_met = yes/(yes+no) >= threshold` (IEEE double division). With zero
  non-abstain votes both are false. Proposal state is `enacted` or `failed`; `passed` is never
  stored because enactment is atomic with the passing check.
- **Standing.** +1 to the proposer when enacted; +1 to every voter (yes, no or abstain) when the
  proposal reaches quorum (a decision, whether it passes or is rejected by threshold). No
  standing when quorum is not met.
- **Params in state.** `state.params` holds the governance params from `params.json` except
  `chain_id`, `protocol_version`, `charter_version` (those are `state.chain_id`,
  `state.protocol_version`, `state.charter.version`). Param types are fixed in code:
  `voting_window_blocks`, `anchor_interval_blocks`, `max_txs_per_block`, `max_tx_bytes` integer
  >= 1; `min_standing_to_propose` integer >= 0; `quorum`, `threshold` number in [0,1];
  `block_interval_seconds` number > 0.
- **Proposal ids** start at 1 (`next_proposal_id` starts at 1). `result` is `null` while open.
- **Block hash** = `blake2b256hex(canonical_json(block))` over the whole block *including*
  `state_root` (the spec phrase "block_without_state_root_recomputed" is ambiguous).
- **Rejected txs** are never placed in blocks; a block always contains only valid txs, and
  re-execution treats an invalid tx as an invalid block. Empty blocks are produced every
  interval (the voting window is counted in blocks).
- **Charter text** is read with CRLF normalised to LF so genesis is identical across hosts.
- `GET /tx/:hash` and the `POST /tx` `result` field are additions beyond the spec's endpoint
  list; they do not affect consensus rules.
