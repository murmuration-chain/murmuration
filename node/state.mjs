// Pure, deterministic state-transition rules (spec/protocol.md, spec/signing.md).
// No I/O, no clocks, no randomness. The same (state, txs) always yields the same state_root.
import { canonicalJson, canonicalBytes } from '../common/canon.mjs';
import {
  blake2b256hex, agentIdFromPubkeyHex, isLowerHex, verifyTxSignature, txHash,
} from '../common/crypto.mjs';

export { verifyTxSignature, txHash };

export const ZERO_HASH = '0'.repeat(64);
export const TX_TYPES = ['register', 'propose', 'vote', 'enact'];
export const PROPOSAL_KINDS = ['set_param', 'amend_charter', 'text'];
export const CHOICES = ['yes', 'no', 'abstain'];

// Fixed type of each governance parameter ("Types are fixed; values are not." - params.json).
const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);
export const PARAM_TYPES = {
  voting_window_blocks: { desc: 'integer >= 1', ok: (v) => isInt(v) && v >= 1 },
  quorum: { desc: 'number in [0,1]', ok: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 },
  threshold: { desc: 'number in [0,1]', ok: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 },
  min_standing_to_propose: { desc: 'integer >= 0', ok: (v) => isInt(v) && v >= 0 },
  anchor_interval_blocks: { desc: 'integer >= 1', ok: (v) => isInt(v) && v >= 1 },
  block_interval_seconds: { desc: 'number > 0', ok: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 },
  max_txs_per_block: { desc: 'integer >= 1', ok: (v) => isInt(v) && v >= 1 },
  max_tx_bytes: { desc: 'integer >= 1', ok: (v) => isInt(v) && v >= 1 },
};

export class TxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TxError';
    this.code = code;
  }
}
const fail = (code, msg) => { throw new TxError(code, msg); };

const isPlainObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
function exactKeys(obj, keys, what) {
  if (!isPlainObject(obj)) fail('bad_format', `${what} must be an object`);
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
    fail('bad_format', `${what} must have exactly the fields: ${want.join(', ')}`);
  }
}

// ---- genesis / hashing ------------------------------------------------------------------

/** genesis = { chain_id, protocol_version, params, charter: {version, text} } */
export function createGenesisState(genesis) {
  const state = {
    chain_id: genesis.chain_id,
    protocol_version: genesis.protocol_version,
    height: 0,
    identities: {},
    params: { ...genesis.params },
    charter: { version: genesis.charter.version, text: genesis.charter.text },
    proposals: {},
    votes: {},
    next_proposal_id: 1,
  };
  for (const [k, v] of Object.entries(state.params)) {
    if (!PARAM_TYPES[k] || !PARAM_TYPES[k].ok(v)) throw new Error(`invalid genesis param ${k}=${v}`);
  }
  return JSON.parse(canonicalJson(state)); // normalised plain copy
}

export function computeStateRoot(state) {
  return blake2b256hex(canonicalBytes(state));
}

/** block_hash = blake2b256(canonical_json(block)) over the full block incl. its state_root. */
export function blockHash(block) {
  return blake2b256hex(canonicalBytes(block));
}

export function genesisBlock(state) {
  return { height: 0, prev_hash: ZERO_HASH, timestamp: 0, txs: [], state_root: computeStateRoot(state) };
}

const clone = (o) => structuredClone(o);

// ---- tally ------------------------------------------------------------------------------

/** Eligible voters = identities registered at or before the proposal's opened_at. */
export function eligibleCount(state, proposal) {
  let n = 0;
  for (const id of Object.values(state.identities)) if (id.registered_at <= proposal.opened_at) n++;
  return n;
}

export function tally(state, pid) {
  const p = state.proposals[String(pid)];
  const votes = state.votes[String(pid)] || {};
  const t = { yes: 0, no: 0, abstain: 0 };
  for (const c of Object.values(votes)) t[c]++;
  return { ...t, eligible: p ? eligibleCount(state, p) : 0 };
}

// ---- transaction rules ------------------------------------------------------------------

function checkShape(tx) {
  exactKeys(tx, ['type', 'from', 'nonce', 'body', 'sig'], 'transaction');
  if (!TX_TYPES.includes(tx.type)) fail('bad_format', `unknown tx type: ${String(tx.type)}`);
  if (!isLowerHex(tx.from, 32)) fail('bad_format', '`from` must be 64 lowercase hex chars');
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0) fail('bad_format', '`nonce` must be a non-negative integer');
  if (!isPlainObject(tx.body)) fail('bad_format', '`body` must be an object');
  if (typeof tx.sig !== 'string') fail('bad_format', '`sig` must be a base64 string');
}

function checkParamValue(key, value) {
  const t = PARAM_TYPES[key];
  if (!t) fail('invalid_payload', `unknown param type for ${key}`);
  if (!t.ok(value)) fail('invalid_payload', `value for ${key} must be ${t.desc}`);
}

function validateProposalPayload(state, kind, payload) {
  if (!isPlainObject(payload)) fail('invalid_payload', 'payload must be an object');
  if (kind === 'set_param') {
    exactKeys(payload, ['key', 'value'], 'set_param payload');
    if (typeof payload.key !== 'string' || !Object.hasOwn(state.params, payload.key)) {
      fail('invalid_payload', `set_param: key must be an existing param (got ${JSON.stringify(payload.key)})`);
    }
    checkParamValue(payload.key, payload.value);
  } else if (kind === 'amend_charter') {
    exactKeys(payload, ['text'], 'amend_charter payload');
    if (typeof payload.text !== 'string' || payload.text.length === 0) fail('invalid_payload', 'amend_charter: text must be a non-empty string');
  } else if (kind === 'text') {
    exactKeys(payload, ['title', 'body'], 'text payload');
    if (typeof payload.title !== 'string' || typeof payload.body !== 'string') fail('invalid_payload', 'text: title and body must be strings');
  }
}

function getProposal(state, pid) {
  if (!Number.isSafeInteger(pid)) fail('bad_format', '`proposal_id` must be an integer');
  const p = state.proposals[String(pid)];
  if (!p) fail('unknown_proposal', `no proposal ${pid}`);
  return p;
}

function resolveProposal(state, pid, p, height) {
  const t = tally(state, pid);
  const decisive = t.yes + t.no;
  const quorumMet = decisive > 0 && decisive / t.eligible >= state.params.quorum;
  const thresholdMet = decisive > 0 && t.yes / decisive >= state.params.threshold;
  const passed = quorumMet && thresholdMet;
  const result = {
    outcome: passed ? 'enacted' : 'failed',
    tally: { yes: t.yes, no: t.no, abstain: t.abstain },
    eligible: t.eligible,
    quorum_met: quorumMet,
    threshold_met: thresholdMet,
    decided_at: height,
  };
  if (!quorumMet) result.reason = 'quorum_not_met';
  else if (!thresholdMet) result.reason = 'threshold_not_met';

  if (passed) {
    if (p.kind === 'set_param') {
      const { key, value } = p.payload;
      result.applied = { key, old: state.params[key], new: value };
      state.params[key] = value;
    } else if (p.kind === 'amend_charter') {
      state.charter = { version: state.charter.version + 1, text: p.payload.text };
      result.applied = { charter_version: state.charter.version };
    }
    state.identities[p.proposer].standing += 1; // proposer: proposal enacted
  }
  if (quorumMet) {
    // every voter (any choice) showed up on a proposal that reached a decision
    for (const voter of Object.keys(state.votes[String(pid)])) state.identities[voter].standing += 1;
  }
  p.state = result.outcome;
  p.result = result;
  return result;
}

/** Applies one tx to `state` IN PLACE. Caller guarantees state is a private copy. */
function applyTxMut(state, tx, ctx) {
  checkShape(tx);
  const height = ctx.height;
  if (canonicalBytes(tx).length > state.params.max_tx_bytes) fail('tx_too_large', `tx exceeds max_tx_bytes (${state.params.max_tx_bytes})`);

  if (tx.type === 'register') {
    exactKeys(tx.body, ['pubkey'], 'register body');
    if (!isLowerHex(tx.body.pubkey, 32)) fail('bad_format', 'pubkey must be 64 lowercase hex chars');
    if (tx.nonce !== 0) fail('bad_nonce', 'register nonce must be 0');
    const id = agentIdFromPubkeyHex(tx.body.pubkey);
    if (tx.from !== id) fail('bad_format', '`from` must equal blake2b256(pubkey)');
    if (!verifyTxSignature(tx, tx.body.pubkey)) fail('bad_signature', 'signature does not verify');
    if (state.identities[id]) fail('already_registered', 'identity already registered');
    state.identities[id] = { pubkey: tx.body.pubkey, registered_at: height, nonce: 0, standing: 0 };
    return { agent_id: id };
  }

  const ident = state.identities[tx.from];
  if (!ident) fail('unknown_identity', 'sender is not a registered identity');
  if (tx.nonce !== ident.nonce + 1) fail('bad_nonce', `expected nonce ${ident.nonce + 1}, got ${tx.nonce}`);
  if (!verifyTxSignature(tx, ident.pubkey)) fail('bad_signature', 'signature does not verify');

  let result;
  if (tx.type === 'propose') {
    exactKeys(tx.body, ['kind', 'payload'], 'propose body');
    if (!PROPOSAL_KINDS.includes(tx.body.kind)) fail('invalid_payload', `unknown proposal kind: ${String(tx.body.kind)}`);
    if (ident.standing < state.params.min_standing_to_propose) fail('insufficient_standing', 'standing below min_standing_to_propose');
    validateProposalPayload(state, tx.body.kind, tx.body.payload);
    const pid = state.next_proposal_id++;
    state.proposals[String(pid)] = {
      kind: tx.body.kind,
      payload: tx.body.payload,
      proposer: tx.from,
      opened_at: height,
      closes_at: height + state.params.voting_window_blocks,
      state: 'open',
      result: null,
    };
    state.votes[String(pid)] = {};
    result = { proposal_id: pid };
  } else if (tx.type === 'vote') {
    exactKeys(tx.body, ['proposal_id', 'choice'], 'vote body');
    if (!CHOICES.includes(tx.body.choice)) fail('bad_format', 'choice must be yes|no|abstain');
    const p = getProposal(state, tx.body.proposal_id);
    // Window rule: a proposal is open for voting while height < closes_at.
    if (p.state !== 'open' || height >= p.closes_at) fail('proposal_closed', 'voting is closed for this proposal');
    if (ident.registered_at > p.opened_at) fail('not_eligible', 'registered after the proposal opened');
    const votes = state.votes[String(tx.body.proposal_id)];
    if (Object.hasOwn(votes, tx.from)) fail('already_voted', 'identity already voted on this proposal');
    votes[tx.from] = tx.body.choice;
    result = { proposal_id: tx.body.proposal_id };
  } else if (tx.type === 'enact') {
    exactKeys(tx.body, ['proposal_id'], 'enact body');
    const pid = tx.body.proposal_id;
    const p = getProposal(state, pid);
    if (p.state !== 'open') {
      result = { proposal_id: pid, noop: true, state: p.state }; // idempotent
    } else {
      if (height < p.closes_at) fail('voting_open', `voting window closes at height ${p.closes_at}`);
      const r = resolveProposal(state, pid, p, height);
      result = { proposal_id: pid, state: p.state, outcome: r.outcome };
    }
  }
  ident.nonce = tx.nonce;
  return result;
}

/** applyTx(state, signedTx, ctx={height}) -> { state: newState, result }. Throws TxError. */
export function applyTx(state, tx, ctx = {}) {
  const next = clone(state);
  const height = ctx.height ?? state.height + 1;
  const result = applyTxMut(next, tx, { height });
  return { state: next, result };
}

/**
 * Sequencer helper: apply as many txs as are valid, in order, at block `height`.
 * Invalid txs are dropped (returned in `rejected`). Never throws on tx errors.
 */
export function executeTxs(state, txs, height) {
  let cur = state;
  const applied = [];
  const results = [];
  const rejected = [];
  for (const tx of txs) {
    try {
      const r = applyTx(cur, tx, { height });
      cur = r.state;
      applied.push(tx);
      results.push(r.result);
    } catch (e) {
      if (!(e instanceof TxError)) throw e;
      rejected.push({ tx, error: e.code, message: e.message });
    }
  }
  return { state: cur, applied, results, rejected };
}

/** applyBlockDetailed(state, block) -> { state, results }. Throws if the block is invalid. */
export function applyBlockDetailed(state, block, { verifyRoot = true } = {}) {
  if (!isPlainObject(block) || !Array.isArray(block.txs)) throw new Error('malformed block');
  if (block.height !== state.height + 1) throw new Error(`block height ${block.height}, expected ${state.height + 1}`);
  if (block.txs.length > state.params.max_txs_per_block) throw new Error('block exceeds max_txs_per_block');
  const next = clone(state);
  const results = [];
  block.txs.forEach((tx, i) => {
    try {
      results.push(applyTxMut(next, tx, { height: block.height }));
    } catch (e) {
      if (e instanceof TxError) throw new Error(`block ${block.height} tx #${i} invalid: ${e.code}: ${e.message}`);
      throw e;
    }
  });
  next.height = block.height;
  if (verifyRoot) {
    const root = computeStateRoot(next);
    if (root !== block.state_root) throw new Error(`block ${block.height} state_root mismatch: computed ${root}, block says ${block.state_root}`);
  }
  return { state: next, results };
}

/** applyBlock(state, block) -> new state (verifies the block's state_root). */
export function applyBlock(state, block, opts) {
  return applyBlockDetailed(state, block, opts).state;
}
