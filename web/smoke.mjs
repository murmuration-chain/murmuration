// Smoke test for the web participation path. Uses web/ledger.mjs (the SAME module the page
// imports) which signs with common/crypto.mjs (the SAME file the node serves to the browser).
//   node web/smoke.mjs [BASE_URL]        default http://127.0.0.1:8645
// Exits non-zero on any failure.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Ledger, keygen } from './ledger.mjs';

const BASE = (process.argv[2] || process.env.NODE_URL || 'http://127.0.0.1:8645').replace(/\/+$/, '');
const root = new URL('..', import.meta.url);
const ok = (m) => console.log('  ok  ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`smoke against ${BASE}`);

// 1. Static serving: the page, and byte-identical common/ + local noble modules.
const get = async (p) => { const r = await fetch(BASE + p); return { r, text: await r.text() }; };
{
  const { r, text } = await get('/');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/); assert.match(text, /Murmuration/);
  ok('GET / serves web/index.html (text/html)');
  for (const f of ['canon.mjs', 'crypto.mjs']) {
    const s = await get('/common/' + f);
    assert.equal(s.r.status, 200); assert.match(s.r.headers.get('content-type'), /text\/javascript/);
    assert.equal(s.text, fs.readFileSync(new URL('common/' + f, root), 'utf8'));
    ok(`GET /common/${f} is byte-identical to the node's own file`);
  }
  for (const f of ['/web/app.js', '/web/ledger.mjs', '/vendor/@noble/ed25519/index.js', '/vendor/@noble/hashes/sha2.js', '/vendor/@noble/hashes/blake2.js', '/vendor/@noble/hashes/utils.js']) {
    const s = await get(f); assert.equal(s.r.status, 200, f); assert.match(s.r.headers.get('content-type'), /text\/javascript/);
  }
  ok('/web/*.js and /vendor/@noble/* served locally as text/javascript (no CDN)');
  assert.notEqual((await fetch(BASE + '/common/..%2fnode%2fstate.mjs')).status, 200);
  assert.equal((await fetch(BASE + '/common/%2e%2e/package.json')).status === 200, false);
  ok('path traversal refused');
}

// 2. Join: keygen in "browser" code path, register.
const key = keygen();
const L = new Ledger(BASE, key);
const reg = await L.register();
console.log('  registered identity', key.agent_id, '| tx', reg.hash.slice(0, 16) + '…', 'included at height', reg.height);
let st = await L.getState();
assert.ok(st.identities[key.agent_id], 'identity in /state');
ok('register tx accepted; identity present in /state');

// 3. Propose (text) + propose (set_param) back-to-back (exercises local nonce counter).
const title = 'smoke ' + Date.now();
const p1 = await L.propose('text', { title, body: 'hello from the browser signing path' }, { wait: false });
const p2 = await L.propose('set_param', { key: 'quorum', value: 0.33 }, { wait: false });
await L.waitForTx(p1.hash); await L.waitForTx(p2.hash);
const pid1 = p1.result.proposal_id, pid2 = p2.result.proposal_id;
st = await L.getState();
assert.equal(st.proposals[pid1].payload.title, title);
assert.equal(st.proposals[pid2].kind, 'set_param');
ok(`proposals #${pid1} (text) and #${pid2} (set_param) visible in /state`);

// 4. Vote.
await L.vote(pid1, 'yes');
await L.vote(pid2, 'no');
st = await L.getState();
assert.equal(st.votes[pid1][key.agent_id], 'yes');
assert.equal(st.votes[pid2][key.agent_id], 'no');
const view = await (await fetch(`${BASE}/proposals/${pid1}`)).json();
assert.equal(view.tally.yes, 1);
ok(`votes recorded; /proposals/${pid1} tally = ${JSON.stringify(view.tally)}`);

// 5. A bad signature must be rejected (proves the node really verifies what the page signs).
const bad = { type: 'vote', from: key.agent_id, nonce: (await L.getIdentity()).nonce + 1, body: { proposal_id: pid1, choice: 'yes' }, sig: Buffer.alloc(64).toString('base64') };
const br = await fetch(BASE + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) });
assert.equal(br.status, 400);
assert.equal((await br.clone().json()).error, 'bad_signature');
ok('forged signature rejected: ' + JSON.stringify(await br.json()));

// 6. Enact after the window closes (only if short enough to wait).
const wait = st.proposals[pid1].closes_at - st.height;
if (wait <= 15) {
  const interval = st.params.block_interval_seconds;
  console.log(`  waiting ~${Math.ceil(wait * interval)}s for the voting window to close (block ${st.proposals[pid1].closes_at})…`);
  for (;;) { st = await L.getState(); if (st.height + 1 >= st.proposals[pid1].closes_at) break; await sleep(500); }
  const en = await L.enact(pid1);
  st = await L.getState();
  console.log('  enact result:', JSON.stringify(en.result), '| proposal state:', st.proposals[pid1].state);
  assert.ok(['enacted', 'failed'].includes(st.proposals[pid1].state));
  ok('enact accepted after window closed');
} else {
  console.log(`  (skipping enact: window is ${wait} blocks; run node with VOTING_WINDOW_BLOCKS=3 on a fresh DATA_DIR to include it)`);
}

console.log('\nSMOKE PASSED');
console.log('  identity :', key.agent_id);
console.log('  proposal :', JSON.stringify({ id: pid1, ...st.proposals[pid1] }));
