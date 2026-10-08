import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGenesisState, applyTx, applyBlock, executeTxs, computeStateRoot, TxError, verifyTxSignature,
} from '../node/state.mjs';
import { readGenesisConfig } from '../node/store.mjs';
import { keypairFromSeedHex, signTx } from '../common/crypto.mjs';

const seedOf = (n) => n.toString(16).padStart(2, '0').repeat(32);
const keys = [1, 2, 3, 4].map((n) => keypairFromSeedHex(seedOf(n)));

function genesis(over = {}) {
  return createGenesisState(readGenesisConfig({ voting_window_blocks: 3, ...over }));
}
const reg = (k) => signTx(k.seed, { type: 'register', from: k.agent_id, nonce: 0, body: { pubkey: k.pubkey } });
const tx = (k, nonce, type, body) => signTx(k.seed, { type, from: k.agent_id, nonce, body });

// Build a block from txs applied at the next height, as the sequencer does.
function block(state, txs) {
  const height = state.height + 1;
  const { state: s, applied, rejected } = executeTxs(state, txs, height);
  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  return { height, prev_hash: '00'.repeat(32), timestamp: 1, txs: applied, state_root: computeStateRoot({ ...s, height }) };
}
const step = (state, txs) => applyBlock(state, block(state, txs));
const empty = (state, n) => { for (let i = 0; i < n; i++) state = step(state, []); return state; };
const code = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof TxError, String(e)); return e.code; }
  return null;
};
const text = { kind: 'text', payload: { title: 'a', body: 'b' } };

test('client-signed tx verifies in node/state.mjs using common crypto', () => {
  const t = reg(keys[0]);
  assert.ok(verifyTxSignature(t, keys[0].pubkey));
  const { state } = applyTx(genesis(), t, { height: 1 });
  assert.ok(state.identities[keys[0].agent_id]);
});

test('lifecycle: register, propose set_param, vote, enact -> param changes, standing awarded', () => {
  let s = genesis();
  s = step(s, keys.slice(0, 3).map(reg));                                   // h1
  const [A, B, C] = keys;
  s = step(s, [tx(A, 1, 'propose', { kind: 'set_param', payload: { key: 'threshold', value: 0.55 } })]); // h2
  const p = s.proposals['1'];
  assert.equal(p.opened_at, 2);
  assert.equal(p.closes_at, 5);
  s = step(s, [tx(A, 2, 'vote', { proposal_id: 1, choice: 'yes' }), tx(B, 1, 'vote', { proposal_id: 1, choice: 'yes' }), tx(C, 1, 'vote', { proposal_id: 1, choice: 'yes' })]); // h3
  assert.equal(code(() => applyTx(s, tx(B, 2, 'enact', { proposal_id: 1 }), { height: 4 })), 'voting_open');
  s = empty(s, 1);                                                          // h4
  s = step(s, [tx(B, 2, 'enact', { proposal_id: 1 })]);                     // h5 == closes_at
  assert.equal(s.proposals['1'].state, 'enacted');
  assert.equal(s.params.threshold, 0.55);
  assert.deepEqual(s.proposals['1'].result.applied, { key: 'threshold', old: 0.6, new: 0.55 });
  assert.equal(s.identities[A.agent_id].standing, 2); // proposer + voter
  assert.equal(s.identities[B.agent_id].standing, 1);
  const again = applyTx(s, tx(C, 2, 'enact', { proposal_id: 1 }), { height: s.height + 1 });
  assert.equal(again.result.noop, true); // idempotent
  assert.equal(again.state.params.threshold, 0.55);
});

test('replay determinism: same blocks -> same state_root; tampered root rejected', () => {
  let s = genesis();
  const blocks = [];
  for (const txs of [keys.slice(0, 2).map(reg), [], [tx(keys[0], 1, 'propose', text)]]) {
    const b = block(s, txs);
    blocks.push(b);
    s = applyBlock(s, b);
  }
  let r = genesis();
  for (const b of blocks) r = applyBlock(r, b);
  assert.equal(computeStateRoot(r), computeStateRoot(s));
  assert.throws(() => applyBlock(genesis(), { ...blocks[0], state_root: '00'.repeat(32) }), /state_root mismatch/);
});

test('rejections: bad nonce, bad signature, unknown identity, duplicate register, bad payloads, voting rules', () => {
  let s = step(genesis({ voting_window_blocks: 5 }), [reg(keys[0]), reg(keys[1])]);
  const h = s.height + 1;
  assert.equal(code(() => applyTx(s, tx(keys[0], 5, 'propose', text), { height: h })), 'bad_nonce');
  const forged = { ...tx(keys[0], 1, 'propose', text), from: keys[1].agent_id, nonce: 1 };
  assert.equal(code(() => applyTx(s, forged, { height: h })), 'bad_signature');
  assert.equal(code(() => applyTx(s, tx(keys[3], 1, 'vote', { proposal_id: 1, choice: 'yes' }), { height: h })), 'unknown_identity');
  assert.equal(code(() => applyTx(s, reg(keys[0]), { height: h })), 'already_registered');
  assert.equal(code(() => applyTx(s, tx(keys[0], 1, 'propose', { kind: 'set_param', payload: { key: 'nope', value: 1 } }), { height: h })), 'invalid_payload');
  assert.equal(code(() => applyTx(s, tx(keys[0], 1, 'propose', { kind: 'set_param', payload: { key: 'quorum', value: 'x' } }), { height: h })), 'invalid_payload');

  s = step(s, [tx(keys[0], 1, 'propose', text)]);   // opens at h2, closes at h5
  s = step(s, [reg(keys[2])]);                       // registers after opening
  assert.equal(code(() => applyTx(s, tx(keys[2], 1, 'vote', { proposal_id: 1, choice: 'yes' }), { height: s.height + 1 })), 'not_eligible');
  s = step(s, [tx(keys[0], 2, 'vote', { proposal_id: 1, choice: 'yes' })]); // h4
  assert.equal(code(() => applyTx(s, tx(keys[0], 3, 'vote', { proposal_id: 1, choice: 'no' }), { height: s.height + 1 })), 'already_voted');
  s = empty(s, 2); // head h6; next block h7 == closes_at (2+5)
  assert.equal(code(() => applyTx(s, tx(keys[1], 1, 'vote', { proposal_id: 1, choice: 'yes' }), { height: s.height + 1 })), 'proposal_closed');
});

test('quorum uses the snapshot at opened_at; failed proposals award voter standing only', () => {
  let s = step(genesis({ quorum: 0.5 }), keys.map(reg)); // 4 identities
  s = step(s, [tx(keys[0], 1, 'propose', text)]);
  s = step(s, [tx(keys[0], 2, 'vote', { proposal_id: 1, choice: 'yes' }), tx(keys[1], 1, 'vote', { proposal_id: 1, choice: 'no' })]); // quorum 2/4 ok, 1/2 < 0.6
  s = empty(s, 3);
  s = step(s, [tx(keys[2], 1, 'enact', { proposal_id: 1 })]);
  assert.equal(s.proposals['1'].state, 'failed');
  assert.equal(s.proposals['1'].result.reason, 'threshold_not_met');
  assert.equal(s.identities[keys[0].agent_id].standing, 1);
  assert.equal(s.identities[keys[3].agent_id].standing, 0);
});
