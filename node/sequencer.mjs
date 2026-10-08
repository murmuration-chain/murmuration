// Single sequencer (v0): admits valid txs into a pending pool and produces a block every
// `block_interval_seconds` (read live from state.params, so governance can change it).
//
// M2 SEAM: Cardano anchoring plugs in via `onBlock(fn)`. The hook receives
// ({ block, hash, state }) after each block is durably appended; an anchoring module checks
// `state.params.anchor_interval_blocks` and submits {chain_id, height, block_hash, state_root}.
// Nothing else in the node needs to change. See anchor/README.md.
import { applyTx, executeTxs, computeStateRoot, txHash, TxError } from './state.mjs';

export class Sequencer {
  constructor(store, { intervalSecondsOverride = null, now = () => Date.now() } = {}) {
    this.store = store;
    this.intervalOverride = intervalSecondsOverride;
    this.now = now;
    this.pending = [];                 // signed txs accepted but not yet in a block
    this.spec = store.state;           // head state + all pending txs applied (admission check)
    this.rejected = new Map();         // tx hash -> { error, message } (bounded)
    this.hooks = [];
    this.timer = null;
    this.running = false;
  }

  /** Register a post-block hook (used by M2 anchoring). */
  onBlock(fn) { this.hooks.push(fn); }

  /** Admit a tx. Returns { hash, result } or throws TxError. */
  submit(tx) {
    const hash = txHash(tx);
    if (this.store.txIndex.has(hash) || this.pending.some((t) => txHash(t) === hash)) {
      throw new TxError('duplicate', 'transaction already submitted');
    }
    const next = applyTx(this.spec, tx, { height: this.store.state.height + 1 });
    this.spec = next.state;
    this.pending.push(tx);
    return { hash, result: next.result };
  }

  /** Produce one block now from the pending pool. Returns the block. */
  produce() {
    const head = this.store.state;
    const height = head.height + 1;
    const max = head.params.max_txs_per_block;
    const batch = this.pending.slice(0, max);
    const leftover = this.pending.slice(max);

    const { state: executed, applied, rejected } = executeTxs(head, batch, height);
    for (const r of rejected) this._remember(txHash(r.tx), { error: r.error, message: r.message });

    const prevHash = this.store.getBlockHash(head.height);
    const prevTs = this.store.getBlock(head.height).timestamp;
    const timestamp = Math.max(Math.floor(this.now() / 1000), prevTs);
    const block = {
      height,
      prev_hash: prevHash,
      timestamp,
      txs: applied,
      state_root: computeStateRoot({ ...executed, height }),
    };
    const newState = this.store.append(block); // re-verifies by full re-execution
    const hash = this.store.getBlockHash(height);

    // rebuild the speculative state: new head + the txs that did not make this block
    this.pending = [];
    this.spec = newState;
    for (const tx of leftover) {
      try {
        this.spec = applyTx(this.spec, tx, { height: height + 1 }).state;
        this.pending.push(tx);
      } catch (e) {
        if (!(e instanceof TxError)) throw e;
        this._remember(txHash(tx), { error: e.code, message: e.message });
      }
    }
    for (const fn of this.hooks) {
      try { fn({ block, hash, state: newState }); } catch (e) { console.error('[sequencer] hook error:', e); }
    }
    return block;
  }

  _remember(hash, info) {
    this.rejected.set(hash, info);
    if (this.rejected.size > 1000) this.rejected.delete(this.rejected.keys().next().value);
  }

  txStatus(hash) {
    const inc = this.store.txIndex.get(hash);
    if (inc) return { status: 'included', height: inc.height, index: inc.index, result: inc.result };
    if (this.pending.some((t) => txHash(t) === hash)) return { status: 'pending' };
    const rej = this.rejected.get(hash);
    if (rej) return { status: 'rejected', ...rej };
    return null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      try { this.produce(); } catch (e) { console.error('[sequencer] produce failed:', e); }
      this.timer = setTimeout(tick, this._intervalMs());
    };
    this.timer = setTimeout(tick, this._intervalMs());
  }

  _intervalMs() {
    const s = this.intervalOverride ?? this.store.state.params.block_interval_seconds;
    return Math.max(10, Math.round(s * 1000));
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
