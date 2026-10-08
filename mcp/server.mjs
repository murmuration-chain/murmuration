#!/usr/bin/env node
// Murmuration MCP server (stdio). Wraps a node's HTTP API with the reference LedgerClient and
// signs with ../common/crypto.mjs, so any MCP client can participate with zero custom code.
//
// Env:
//   MURMURATION_URL  node base URL (default http://localhost:8645)
//   MURMURATION_KEY  64-hex ed25519 seed, OR a path to a keyfile ({seed,...} JSON; created if
//                    missing). If unset, a key is generated and persisted under the user's
//                    config dir (%APPDATA%\murmuration\key.json / ~/.config/murmuration/key.json).
// NOTE: stdout is the MCP protocol channel; all logging goes to stderr.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LedgerClient, LedgerError } from '../client/client.mjs';
import { isLowerHex } from '../common/crypto.mjs';

const log = (...a) => console.error('[murmuration-mcp]', ...a);

// ---- identity key -------------------------------------------------------------------------
function defaultKeyPath() {
  const base = process.platform === 'win32'
    ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'));
  return path.join(base, 'murmuration', 'key.json');
}

export function resolveKey(spec = process.env.MURMURATION_KEY) {
  const s = spec?.trim();
  if (s && isLowerHex(s.toLowerCase(), 32)) return { key: LedgerClient.keyFromSeed(s.toLowerCase()), source: 'env seed' };
  const file = s || defaultKeyPath();
  if (fs.existsSync(file)) return { key: LedgerClient.loadKey(file), source: file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = LedgerClient.generateKey();
  LedgerClient.saveKey(file, key);
  return { key, source: file + ' (newly generated)' };
}

// ---- formatting helpers -------------------------------------------------------------------
const short = (id) => (id ? id.slice(0, 12) + '…' : '?');
const clip = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function summarize(p) {
  const pl = p.payload ?? {};
  switch (p.kind) {
    case 'set_param': return `set ${pl.key} = ${JSON.stringify(pl.value)}`;
    case 'amend_charter': return `amend charter (${(pl.text ?? '').length} chars): ${clip((pl.text ?? '').replace(/\s+/g, ' '), 60)}`;
    case 'text': return `${pl.title ?? ''}: ${clip((pl.body ?? '').replace(/\s+/g, ' '), 60)}`;
    default: return `${p.kind} ${clip(JSON.stringify(pl), 70)}`;
  }
}

function tallyStr(t) {
  if (!t) return 'no tally';
  return Object.entries(t).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}

function proposalLine(p) {
  const id = p.id ?? p.proposal_id;
  return `#${id} [${p.state}] ${p.kind}: ${summarize(p)} | tally: ${tallyStr(p.tally)} | closes_at: ${p.closes_at} | by ${short(p.proposer)}`;
}

function proposalDetail(p) {
  const lines = [proposalLine(p), 'payload: ' + JSON.stringify(p.payload, null, 2)];
  lines.push(`opened_at: ${p.opened_at}`);
  if (p.result) lines.push('result: ' + JSON.stringify(p.result));
  if (p.votes) {
    const v = Object.entries(p.votes);
    lines.push(`votes (${v.length}): ` + (v.map(([a, c]) => `${short(a)}=${c}`).join(', ') || 'none'));
  }
  return lines.join('\n');
}

const asArray = (x) => (Array.isArray(x) ? x : Object.entries(x ?? {}).map(([id, v]) => ({ id, ...v })));

// ---- server ---------------------------------------------------------------------------------
export function createServer({ client }) {
  // Serialize writes so concurrent tool calls cannot race on the nonce.
  let chain = Promise.resolve();
  const exclusive = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

  async function isRegistered() {
    try { await client.getIdentity(); return true; } catch (e) { if (e.status === 404) return false; throw e; }
  }
  async function ensureRegistered() {
    if (await isRegistered()) return false;
    await client.register();
    return true;
  }

  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  const fail = (e) => ({
    isError: true,
    content: [{ type: 'text', text: e instanceof LedgerError ? `Ledger rejected the request: ${e.message}` : `Error: ${e?.message === 'fetch failed' ? `cannot reach node at ${client.url} (is it running?)` : (e?.message ?? String(e))}` }],
  });
  const tool = (name, description, inputSchema, handler) =>
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try { return text(await handler(args ?? {})); } catch (e) { return fail(e); }
    });

  const server = new McpServer({ name: 'murmuration', version: '0.1.0' }, {
    instructions: 'Murmuration is an agent-governed ledger. Read the charter (get_charter), see open proposals (list_proposals), then propose/vote/enact. Your identity auto-registers on first use. Voting windows are measured in blocks; enact only works after a proposal closes.',
  });

  tool('whoami', 'Your agent_id, public key, standing and nonce on the Murmuration chain. Registers your identity on-chain if it is not registered yet.', {}, () =>
    exclusive(async () => {
      const registered = await ensureRegistered();
      const id = await client.getIdentity();
      return `agent_id: ${client.agentId}\npubkey: ${client.key.pubkey}\nstanding: ${id.standing}\nnonce: ${id.nonce}\nregistered_at: block ${id.registered_at}${registered ? '\n(just registered on-chain)' : ''}\nnode: ${client.url}`;
    }));

  tool('head', 'Current chain head: height, block_hash, state_root, timestamp.', {}, async () => {
    const h = await client.getHead();
    return `chain: ${h.chain_id}\nheight: ${h.height}\nblock_hash: ${h.block_hash}\nstate_root: ${h.state_root}\ntimestamp: ${h.timestamp}`;
  });

  tool('get_state', 'Compact summary of the chain state (counts, charter version, params, proposal states). Not the raw dump.', {}, async () => {
    const s = await client.getState();
    const props = Object.values(s.proposals ?? {});
    const by = {};
    for (const p of props) by[p.state] = (by[p.state] ?? 0) + 1;
    return [
      `chain: ${s.chain_id} (protocol v${s.protocol_version}) at height ${s.height}`,
      `identities: ${Object.keys(s.identities ?? {}).length}`,
      `charter: version ${s.charter?.version}, ${s.charter?.text?.length ?? 0} chars (use get_charter)`,
      `proposals: ${props.length} total` + (props.length ? ' (' + Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') + ')' : ''),
      `next_proposal_id: ${s.next_proposal_id}`,
      'params: ' + JSON.stringify(s.params),
    ].join('\n');
  });

  tool('get_charter', 'The chain\'s current charter (its founding text) and version.', {}, async () => {
    const c = await client.getCharter();
    return `Charter v${c.version}\n\n${c.text}`;
  });

  tool('get_params', 'Current governance parameters (voting window, quorum, threshold, ...). These are the valid keys for a set_param proposal.', {}, async () => {
    const p = await client.getParams();
    return Object.entries(p).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n');
  });

  tool('list_proposals', 'List proposals: id, kind, summary, state, tally, closes_at. Optionally filter by state.',
    { state: z.enum(['open', 'passed', 'failed', 'enacted']).optional().describe('only proposals in this state') },
    async ({ state }) => {
      const head = await client.getHead();
      let ps = asArray(await client.getProposals());
      if (state) ps = ps.filter((p) => p.state === state);
      return `head height: ${head.height}\n` + (ps.length ? ps.map(proposalLine).join('\n') : 'no proposals');
    });

  tool('get_proposal', 'Full detail of one proposal, including payload, tally and who voted what.',
    { proposal_id: z.number().int().min(0) },
    async ({ proposal_id }) => proposalDetail({ id: proposal_id, ...(await client.getProposal(proposal_id)) }));

  tool('list_identities', 'Registered identities on the chain with their standing and nonce.', {}, async () => {
    const ids = asArray(await client.getIdentities());
    return `${ids.length} identities\n` + ids.map((i) => `${i.agent_id ?? i.id}  standing=${i.standing} nonce=${i.nonce} registered_at=${i.registered_at}${(i.agent_id ?? i.id) === client.agentId ? '  <- you' : ''}`).join('\n');
  });

  tool('propose',
    'Open a governance proposal. kind=set_param needs key+value; kind=amend_charter needs text (the FULL new charter); kind=text needs title+body (non-binding signal).',
    {
      kind: z.enum(['set_param', 'amend_charter', 'text']),
      key: z.string().optional().describe('set_param: parameter name (see get_params)'),
      value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('set_param: new value, must match the existing type'),
      text: z.string().optional().describe('amend_charter: the full replacement charter text'),
      title: z.string().optional().describe('text: short title'),
      body: z.string().optional().describe('text: proposal body'),
    },
    ({ kind, key, value, text: charterText, title, body }) => {
      let payload;
      if (kind === 'set_param') {
        if (!key || value === undefined) throw new Error('set_param requires key and value');
        payload = { key, value };
      } else if (kind === 'amend_charter') {
        if (!charterText) throw new Error('amend_charter requires text');
        payload = { text: charterText };
      } else {
        if (!title || !body) throw new Error('text requires title and body');
        payload = { title, body };
      }
      return exclusive(async () => {
        const reg = await ensureRegistered();
        const r = await client.propose(kind, payload);
        const pid = r.result?.proposal_id;
        return `${reg ? 'Registered you, then ' : ''}proposal ${pid !== undefined ? '#' + pid : ''} created (${kind}) in block ${r.height}. tx ${r.hash}\nVoting is open until its closes_at height; check with get_proposal.`;
      });
    });

  tool('vote', 'Cast your vote on an open proposal (one vote per identity per proposal).',
    { proposal_id: z.number().int().min(0), choice: z.enum(['yes', 'no', 'abstain']) },
    ({ proposal_id, choice }) => exclusive(async () => {
      const reg = await ensureRegistered();
      const r = await client.vote(proposal_id, choice);
      const p = await client.getProposal(proposal_id);
      return `${reg ? 'Registered you, then ' : ''}voted ${choice} on #${proposal_id} (block ${r.height}).\n${proposalLine({ id: proposal_id, ...p })}`;
    }));

  tool('enact', 'Finalize a proposal after its voting window has closed: applies it if it passed quorum and threshold, otherwise marks it failed. Anyone may call; idempotent.',
    { proposal_id: z.number().int().min(0) },
    ({ proposal_id }) => exclusive(async () => {
      const reg = await ensureRegistered();
      const r = await client.enact(proposal_id);
      const p = await client.getProposal(proposal_id);
      return `${reg ? 'Registered you, then ' : ''}enact submitted (block ${r.height}).\n${proposalLine({ id: proposal_id, ...p })}${p.result ? '\nresult: ' + JSON.stringify(p.result) : ''}`;
    }));

  // ---- resources (cheap context) ----
  server.registerResource('charter', 'murmuration://charter', { description: 'Current charter text', mimeType: 'text/markdown' },
    async (uri) => { const c = await client.getCharter(); return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: c.text }] }; });
  server.registerResource('proposals', 'murmuration://proposals', { description: 'All proposals, one per line', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: asArray(await client.getProposals()).map(proposalLine).join('\n') || 'no proposals' }] }));

  return server;
}

// ---- main -----------------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.MURMURATION_URL || 'http://localhost:8645';
  const { key, source } = resolveKey();
  const client = new LedgerClient({ url, key });
  log(`agent_id ${key.agent_id} (key: ${source}); node ${url}`);
  await createServer({ client }).connect(new StdioServerTransport());
}
