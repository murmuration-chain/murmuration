// Smoke test: spawns server.mjs over stdio, speaks MCP to it via the SDK client, and exercises
// every tool against a live node (MURMURATION_URL, default http://localhost:8645).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LedgerClient } from '../client/client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.MURMURATION_URL || 'http://localhost:8645';
const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mmcp-')), 'key.json'); // exercises generate+persist
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(here, 'server.mjs')],
  env: { ...process.env, MURMURATION_URL: url, MURMURATION_KEY: keyFile }, stderr: 'inherit',
});
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(transport);

const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  console.log(`\n>>> ${name} ${JSON.stringify(args).slice(0, 100)}${r.isError ? '   [isError]' : ''}\n${r.content[0].text}`);
  return r;
};
const ok = (cond, msg) => { console.log(cond ? 'PASS' : 'FAIL', msg); if (!cond) process.exitCode = 1; };

const { tools } = await c.listTools();
console.log('TOOLS:', tools.map((t) => t.name).join(', '));
const { resources } = await c.listResources();
console.log('RESOURCES:', resources.map((r) => r.uri).join(', '));

await call('head');
const who = await call('whoami');
const myId = /agent_id: (\w+)/.exec(who.content[0].text)[1];
await call('get_params');
await call('get_state');
const pr = await call('propose', { kind: 'text', title: 'MCP smoke', body: 'Hello from the MCP server.' });
const pid = Number(/#(\d+)/.exec(pr.content[0].text)[1]);
await call('propose', { kind: 'set_param', key: 'voting_window_blocks', value: 25 });
await call('vote', { proposal_id: pid, choice: 'yes' });
await call('vote', { proposal_id: pid, choice: 'yes' }); // expect already_voted error surfaced
await call('list_proposals');
await call('get_proposal', { proposal_id: pid });
await call('list_identities');
await call('propose', { kind: 'set_param', key: 'nope' }); // validation error
await call('enact', { proposal_id: pid });                 // expect voting_open (or enacted if window closed)
const res = await c.readResource({ uri: 'murmuration://charter' });
console.log('\nRESOURCE charter:', res.contents[0].text.split('\n')[0]);
await c.close();

// independently confirm via the node's own /state
const ledger = new LedgerClient({ url });
const s = await ledger.getState();
ok(!!s.identities[myId], 'identity present in /state');
ok(s.proposals[pid]?.kind === 'text', `proposal #${pid} present in /state`);
ok(s.votes[pid]?.[myId] === 'yes', `vote yes by ${myId.slice(0, 12)}… present in /state.votes`);
