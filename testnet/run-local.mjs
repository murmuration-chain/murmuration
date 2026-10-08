// End-to-end local demo (acceptance test for M1). Spawns a real node process with a FAST
// config, drives it with the reference client, then independently re-executes the persisted
// block log in a second process and asserts the state roots match.
//   node testnet/run-local.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LedgerClient } from '../client/client.mjs';
import { blake2b256hex, verifyTxSignature as commonVerify } from '../common/crypto.mjs';
import { verifyTxSignature as nodeVerify, computeStateRoot } from '../node/state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.data', 'testnet');
const BLOCK_INTERVAL = 0.5;
const VOTING_WINDOW = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  return ok;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  console.log(`== starting node on ${url} (block interval ${BLOCK_INTERVAL}s, voting window ${VOTING_WINDOW} blocks)`);
  const child = spawn(process.execPath, [path.join(ROOT, 'node', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), DATA_DIR, BLOCK_INTERVAL_SECONDS: String(BLOCK_INTERVAL), VOTING_WINDOW_BLOCKS: String(VOTING_WINDOW) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', (d) => process.stdout.write('   ' + d.toString().replace(/\n(?=.)/g, '\n   ')));

  try {
    const probe = new LedgerClient({ url });
    for (let i = 0; ; i++) {
      try { await probe.getHealth(); break; } catch { if (i > 100) throw new Error('node did not start'); await sleep(100); }
    }

    // ---- 3 distinct identities ---------------------------------------------------------
    const names = ['A', 'B', 'C'];
    const clients = names.map(() => new LedgerClient({ url, key: LedgerClient.generateKey() }));
    check('3 distinct keys', new Set(clients.map((c) => c.agentId)).size === 3);
    await Promise.all(clients.map((c) => c.register()));
    const ids = await probe.getIdentities();
    check('3 identities registered', ids.length === 3, `(${ids.length})`);
    const [A, B, C] = clients;

    // ---- proposal ----------------------------------------------------------------------
    const before = (await probe.getParams()).threshold;
    const newValue = 0.55;
    const prop = await A.propose('set_param', { key: 'threshold', value: newValue });
    const pid = prop.result.proposal_id;
    console.log(`== A proposed set_param threshold ${before} -> ${newValue} as proposal #${pid}`);
    await Promise.all(clients.map((c) => c.vote(pid, 'yes')));
    const open = await probe.getProposal(pid);
    console.log(`== votes in: ${JSON.stringify(open.tally)}; voting closes at height ${open.closes_at}; waiting`);
    check('proposal still open before window closes', open.state === 'open');

    // an early enact must be refused
    let early = null;
    try { await B.enact(pid, { wait: false }); } catch (e) { early = e.code; }
    check('early enact refused', early === 'voting_open', `(${early})`);

    await probe.waitForHeight(open.closes_at);
    const enactRes = await B.enact(pid);
    console.log(`== B enacted proposal #${pid} at block ${enactRes.height}`);

    // ---- assertions on live state ------------------------------------------------------
    const state = await probe.getState();
    const p = await probe.getProposal(pid);
    check('proposal state is enacted', p.state === 'enacted', `(${p.state})`);
    check(`param threshold changed ${before} -> ${newValue}`, state.params.threshold === newValue && before === 0.6, `(now ${state.params.threshold})`);
    const standing = Object.fromEntries(names.map((n, i) => [n, state.identities[clients[i].agentId].standing]));
    check('standing awarded (A=2: proposer+voter; B=1; C=1)', standing.A === 2 && standing.B === 1 && standing.C === 1, JSON.stringify(standing));

    // ---- #4 node and client agree on signing -------------------------------------------
    const log = await probe.getBlocks(-1);
    const regTx = log.flatMap((b) => b.block.txs).find((t) => t.type === 'register' && t.from === A.agentId);
    const fresh = A.sign({ type: 'vote', from: A.agentId, nonce: 999, body: { proposal_id: 1, choice: 'yes' } });
    check('client signature verifies in node/state.mjs (register tx from chain)', nodeVerify(regTx, A.key.pubkey));
    check('client signature verifies in node/state.mjs (freshly signed tx) and via common', nodeVerify(fresh, A.key.pubkey) && commonVerify(fresh, A.key.pubkey));
    check('agent_id == blake2b256(pubkey)', A.agentId === blake2b256hex(Buffer.from(A.key.pubkey, 'hex')));

    // ---- #3 determinism ----------------------------------------------------------------
    let head, st;
    for (let i = 0; i < 50; i++) { // read /head and /state at the same height
      head = await probe.getHead(); st = await probe.getState();
      if (st.height === head.height) break;
    }
    const clientRoot = computeStateRoot(st);
    check('client recomputes /state root == /head state_root (same height)', st.height === head.height && clientRoot === head.state_root, `h=${head.height}`);

    const out = execFileSync(process.execPath, [path.join(ROOT, 'node', 'verify.mjs'), DATA_DIR, String(head.height)], { encoding: 'utf8' });
    const re = JSON.parse(out.trim().split('\n').pop());
    const det = re.height === head.height && re.state_root === head.state_root;
    console.log(`== independent re-execution from genesis (separate process): height ${re.height}, ${re.blocks} blocks`);
    console.log(`   node head state_root : ${head.state_root}`);
    console.log(`   re-executed          : ${re.state_root}`);
    check('DETERMINISM: re-executed state_root == node head state_root', det);

    // ---- summary -----------------------------------------------------------------------
    console.log('\n================ SUMMARY ================');
    console.log('chain_id   :', state.chain_id);
    console.log('identities :');
    names.forEach((n, i) => console.log(`  ${n}  ${clients[i].agentId}  standing=${standing[n]}  nonce=${state.identities[clients[i].agentId].nonce}`));
    console.log(`proposal #${pid}: ${p.kind} ${JSON.stringify(p.payload)}`);
    console.log(`  proposer=${names[clients.findIndex((c) => c.agentId === p.proposer)]} opened_at=${p.opened_at} closes_at=${p.closes_at} state=${p.state}`);
    console.log(`  tally=${JSON.stringify(p.tally)} result=${JSON.stringify(p.result)}`);
    console.log(`param threshold: before=${before} after=${state.params.threshold}`);
    console.log(`head: height=${head.height} block_hash=${head.block_hash}`);
    console.log(`      state_root=${head.state_root}`);
    console.log('=========================================');
  } finally {
    child.kill();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `\nFAILED: ${failed.length} of ${checks.length} checks` : `\nALL ${checks.length} CHECKS PASSED`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('testnet run failed:', e); process.exit(1); });
