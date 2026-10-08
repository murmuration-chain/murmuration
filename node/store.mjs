// Append-only block log (JSONL) + replay. The log is the single source of truth: state is
// always rebuilt by re-executing every block from genesis, verifying prev_hash, height and
// state_root at each step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../common/canon.mjs';
import {
  createGenesisState, genesisBlock, blockHash, applyBlockDetailed, computeStateRoot, txHash,
} from './state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DATA_DIR = path.join(ROOT, '.data');
export const GENESIS_DIR = path.join(ROOT, 'genesis');

const NON_PARAM_KEYS = new Set(['_comment', 'chain_id', 'protocol_version', 'charter_version']);

/**
 * Build the genesis config object from genesis/params.json + genesis/charter.md.
 * `paramOverrides` (tests only) replace governance params; the resulting config is persisted
 * to DATA_DIR/genesis.json so every replay of this data dir uses the identical genesis.
 */
export function readGenesisConfig(paramOverrides = {}) {
  const raw = JSON.parse(fs.readFileSync(path.join(GENESIS_DIR, 'params.json'), 'utf8'));
  const text = fs.readFileSync(path.join(GENESIS_DIR, 'charter.md'), 'utf8').replace(/\r\n/g, '\n');
  const params = {};
  for (const [k, v] of Object.entries(raw)) if (!NON_PARAM_KEYS.has(k)) params[k] = v;
  Object.assign(params, paramOverrides);
  return {
    chain_id: raw.chain_id,
    protocol_version: raw.protocol_version,
    params,
    charter: { version: raw.charter_version, text },
  };
}

export class Store {
  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.genesisPath = path.join(dataDir, 'genesis.json');
    this.logPath = path.join(dataDir, 'blocks.jsonl');
    this.genesis = null;
    this.blocks = [];       // blocks[h] is the block at height h (index 0 = genesis block)
    this.hashes = [];       // block hashes, parallel to blocks
    this.txIndex = new Map(); // tx hash -> { height, index, result }
    this.state = null;      // head state
  }

  /** Load (or initialise) the data dir, replaying the whole log from genesis. */
  load(paramOverrides = {}, { maxHeight = Infinity, readOnly = false } = {}) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(this.genesisPath)) {
      this.genesis = JSON.parse(fs.readFileSync(this.genesisPath, 'utf8'));
    } else {
      this.genesis = readGenesisConfig(paramOverrides);
      fs.writeFileSync(this.genesisPath, canonicalJson(this.genesis) + '\n');
    }
    let state = createGenesisState(this.genesis);
    const g = genesisBlock(state);
    this.blocks = [g];
    this.hashes = [blockHash(g)];
    this.txIndex.clear();

    if (!fs.existsSync(this.logPath) || fs.statSync(this.logPath).size === 0) {
      if (readOnly) throw new Error('empty or missing block log');
      fs.writeFileSync(this.logPath, canonicalJson(g) + '\n');
    } else {
      const lines = fs.readFileSync(this.logPath, 'utf8').split('\n');
      let dropped = false;
      const parsed = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '') continue;
        try {
          parsed.push(JSON.parse(lines[i]));
        } catch (e) {
          if (i >= lines.length - 2) {
            // torn final write (crash mid-append): drop it
            console.warn(`[store] discarding torn final log line ${i + 1}`);
            dropped = true;
            break;
          }
          throw new Error(`corrupt log line ${i + 1}: ${e.message}`);
        }
      }
      if (parsed.length === 0 || canonicalJson(parsed[0]) !== canonicalJson(g)) {
        throw new Error('log block 0 does not match the genesis block derived from genesis.json');
      }
      for (const block of parsed.slice(1)) {
        if (block.height > maxHeight) break;
        const r = this._replayBlock(state, block);
        state = r;
      }
      if (dropped && !readOnly) fs.writeFileSync(this.logPath, parsed.map((b) => canonicalJson(b)).join('\n') + '\n');
    }
    this.state = state;
    return { state, genesis: this.genesis };
  }

  _replayBlock(state, block) {
    const prev = this.blocks[this.blocks.length - 1];
    if (block.prev_hash !== this.hashes[this.hashes.length - 1]) throw new Error(`block ${block.height}: prev_hash does not link to block ${prev.height}`);
    const { state: next, results } = applyBlockDetailed(state, block);
    this.blocks.push(block);
    this.hashes.push(blockHash(block));
    block.txs.forEach((tx, index) => this.txIndex.set(txHash(tx), { height: block.height, index, result: results[index] }));
    return next;
  }

  /** Validate (against the current head) and durably append a block; returns the new state. */
  append(block) {
    const next = this._replayBlock(this.state, block);
    fs.appendFileSync(this.logPath, canonicalJson(block) + '\n');
    this.state = next;
    return next;
  }

  head() {
    const h = this.blocks.length - 1;
    return {
      chain_id: this.state.chain_id,
      height: h,
      block_hash: this.hashes[h],
      prev_hash: this.blocks[h].prev_hash,
      timestamp: this.blocks[h].timestamp,
      state_root: this.blocks[h].state_root,
    };
  }

  getBlock(height) { return this.blocks[height] ?? null; }
  getBlockHash(height) { return this.hashes[height] ?? null; }
}

/** Independent re-execution helper used by node/verify.mjs and the testnet check. */
export function replayFromDisk(dataDir, maxHeight = Infinity) {
  const store = new Store(dataDir);
  if (!fs.existsSync(store.genesisPath)) throw new Error(`no genesis.json in ${dataDir}`);
  const { state } = store.load({}, { maxHeight, readOnly: true });
  return {
    height: state.height,
    state_root: computeStateRoot(state),
    head_block_hash: store.hashes[store.hashes.length - 1],
    recorded_state_root: store.blocks[store.blocks.length - 1].state_root,
    blocks: store.blocks.length,
  };
}
