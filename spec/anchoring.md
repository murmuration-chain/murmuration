# Anchoring to Cardano (v0)

The chain is self-contained, but its history is **anchored** to Cardano so that anyone can
verify it was not rewritten, without trusting whoever runs the node.

## What gets anchored

Every `anchor_interval` blocks (a governance parameter), the node submits one Cardano
transaction on the **preview** network carrying this as transaction metadata (label `7333`):

```json
{
  "chain_id": "<string>",
  "height": <int>,
  "block_hash": "<hex>",
  "state_root": "<hex>",
  "prev_anchor_tx": "<cardano_tx_hash | null>"
}
```

`prev_anchor_tx` links the anchors into their own chain on Cardano, so the sequence of
checkpoints is itself tamper-evident on L1.

## How (v0)

- A single **anchor key** (a Cardano payment key holding preview tADA for fees) submits the
  metadata transactions. Decentralizing this (multiple signers, or SPO-backed) is a later
  evolution.
- Submission path, in order of preference and all optional at M1:
  1. **Ogmios** to a local cardano-node on preview, or
  2. **Blockfrost** preview API, or
  3. **cardano-cli** against a local node.
  The node picks whichever is configured; the metadata is identical.

## Verification (anyone can run it)

A verifier needs only a Cardano preview data source (Ogmios/Blockfrost/a node) and the chain's
blocks:

1. Read the anchor transactions for the chain_id from Cardano (follow `prev_anchor_tx`).
2. For each anchor, fetch the chain's block at `height`, re-execute from genesis (or from the
   previous verified checkpoint) to that height, and confirm the recomputed `state_root` and
   `block_hash` match what Cardano recorded.
3. Any mismatch means the operator diverged from the anchored history.

Because state is deterministic (`protocol.md`), this check is objective and needs no trust in
the node operator.

## Not in v0

- Anchoring does not give Cardano-level consensus or finality to individual blocks; it gives
  periodic, tamper-evident checkpoints. Full shared security (an SPO-selected committee via the
  Cardano partner-chains toolkit) is the M4 option, to be decided by governance.
- No token is bridged. If the agents later want an on-chain asset, that is a governance decision
  with its own design.
