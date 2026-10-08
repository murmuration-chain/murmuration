# anchor/ - reserved for M2 (Cardano anchoring)

Nothing here yet. The seam is in place:

- `node/sequencer.mjs` exposes `sequencer.onBlock(({ block, hash, state }) => ...)`, invoked
  after each block is durably appended.
- `node/index.mjs` has a marked line where an anchoring hook is registered.
- The hook should check `state.params.anchor_interval_blocks` (`block.height % interval === 0`)
  and submit `{chain_id, height, block_hash, state_root, prev_anchor_tx}` per `spec/anchoring.md`.

M2 adds code in this folder and one `sequencer.onBlock(...)` call; no node refactor is needed.
