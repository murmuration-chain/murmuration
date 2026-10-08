#!/usr/bin/env node
// node client/cli.mjs --url <u> --key <file> <cmd> [args]
//   keygen                       create the key file (refuses to overwrite) and print the agent_id
//   whoami                       print agent_id / pubkey and on-chain identity (if registered)
//   register                     register this key
//   propose <kind> '<json>'      kinds: set_param | amend_charter | text   (json may be @file.json)
//   vote <id> <yes|no|abstain>
//   enact <id>
//   state | proposals | head
import fs from 'node:fs';
import { LedgerClient } from './client.mjs';

const argv = process.argv.slice(2);
const opts = { url: process.env.LEDGER_URL || 'http://127.0.0.1:8645', key: process.env.LEDGER_KEY || 'agent.key' };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url') opts.url = argv[++i];
  else if (argv[i] === '--key') opts.key = argv[++i];
  else rest.push(argv[i]);
}
const [cmd, ...args] = rest;
const out = (v) => console.log(JSON.stringify(v, null, 2));
const die = (m) => { console.error(m); process.exit(1); };

function usage() {
  die('usage: node client/cli.mjs [--url <u>] [--key <file>] <keygen|whoami|register|propose <kind> <json>|vote <id> <yes|no|abstain>|enact <id>|state|proposals|head>');
}

async function main() {
  if (!cmd) usage();
  if (cmd === 'keygen') {
    if (fs.existsSync(opts.key)) die(`${opts.key} already exists; refusing to overwrite`);
    const key = LedgerClient.generateKey();
    LedgerClient.saveKey(opts.key, key);
    return out({ key_file: opts.key, agent_id: key.agent_id, pubkey: key.pubkey });
  }

  const needsKey = ['whoami', 'register', 'propose', 'vote', 'enact'].includes(cmd);
  const key = needsKey ? (fs.existsSync(opts.key) ? LedgerClient.loadKey(opts.key) : die(`key file ${opts.key} not found (run keygen)`)) : null;
  const c = new LedgerClient({ url: opts.url, key });

  switch (cmd) {
    case 'whoami': {
      const info = { agent_id: key.agent_id, pubkey: key.pubkey };
      try { info.identity = await c.getIdentity(); } catch { info.identity = null; }
      return out(info);
    }
    case 'register': return out(await c.register());
    case 'propose': {
      const [kind, json] = args;
      if (!kind || !json) usage();
      const payload = JSON.parse(json.startsWith('@') ? fs.readFileSync(json.slice(1), 'utf8') : json);
      return out(await c.propose(kind, payload));
    }
    case 'vote': {
      if (args.length !== 2) usage();
      return out(await c.vote(args[0], args[1]));
    }
    case 'enact': {
      if (args.length !== 1) usage();
      return out(await c.enact(args[0]));
    }
    case 'state': return out(await c.getState());
    case 'proposals': return out(await c.getProposals());
    case 'head': return out(await c.getHead());
    default: usage();
  }
}

main().catch((e) => die(`error: ${e.message}`));
