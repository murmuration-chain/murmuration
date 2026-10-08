// HTTP/JSON API (spec/signing.md "HTTP"). Plain node:http, no framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tally, TxError } from './state.mjs';

const MAX_BODY_BYTES = 1 << 20;

// ---- static files for the browser UI (web/). No API or consensus change. -------------------
// GET /            -> web/index.html
// GET /web/*       -> web/*
// GET /common/*    -> common/*  (the SAME canon.mjs / crypto.mjs the node uses, so the browser signs identically)
// GET /vendor/@noble/* -> node_modules/@noble/*.js  (served locally; the page's importmap points here, no CDN)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_ROUTES = [
  { prefix: '/web/', dir: path.join(ROOT, 'web') },
  { prefix: '/common/', dir: path.join(ROOT, 'common') },
  { prefix: '/vendor/@noble/', dir: path.join(ROOT, 'node_modules', '@noble') },
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Returns true if the request was handled as a static file (or a static 404/403). */
function serveStatic(req, res, pathname) {
  let file = null;
  if (pathname === '/' || pathname === '/index.html') file = path.join(ROOT, 'web', 'index.html');
  else {
    for (const r of STATIC_ROUTES) {
      if (!pathname.startsWith(r.prefix)) continue;
      let rel;
      try { rel = decodeURIComponent(pathname.slice(r.prefix.length)); } catch { return sendErr(res, 400, 'bad_request', 'bad path'), true; }
      const full = path.resolve(r.dir, rel);
      if (rel.includes('\0') || (full !== r.dir && !full.startsWith(r.dir + path.sep))) return sendErr(res, 403, 'forbidden', 'path escapes static root'), true;
      file = full;
      break;
    }
  }
  if (!file) return false;
  const type = MIME[path.extname(file).toLowerCase()];
  let st;
  try { st = fs.statSync(file); } catch { st = null; }
  if (!type || !st || !st.isFile()) return sendErr(res, 404, 'not_found', 'no such file'), true;
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...CORS });
  res.end(body);
}
const sendErr = (res, status, error, message) => send(res, status, { error, message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY_BYTES) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer({ store, sequencer }) {
  const proposalView = (id) => {
    const state = store.state;
    const p = state.proposals[id];
    return { id: Number(id), ...p, tally: tally(state, id) };
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const state = store.state;

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    if (req.method === 'POST' && url.pathname === '/tx') {
      let tx;
      try { tx = JSON.parse(await readBody(req)); } catch (e) {
        if (e.status === 413) return sendErr(res, 413, 'too_large', 'request body too large');
        return sendErr(res, 400, 'bad_request', 'body is not valid JSON');
      }
      try {
        const { hash, result } = sequencer.submit(tx);
        return send(res, 200, { accepted: true, hash, status: 'pending', result });
      } catch (e) {
        if (e instanceof TxError) return sendErr(res, 400, e.code, e.message);
        throw e;
      }
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;

    if (req.method !== 'GET') return sendErr(res, 405, 'method_not_allowed', 'unsupported method');

    const [a, b] = parts;
    if (parts.length === 1 && a === 'health') return send(res, 200, { ok: true, chain_id: state.chain_id, height: state.height });
    if (parts.length === 1 && a === 'state') return send(res, 200, state);
    if (parts.length === 1 && a === 'head') return send(res, 200, store.head());
    if (parts.length === 1 && a === 'params') return send(res, 200, state.params);
    if (parts.length === 1 && a === 'charter') return send(res, 200, state.charter);

    if (a === 'identities' && parts.length === 1) {
      return send(res, 200, Object.entries(state.identities).map(([agent_id, v]) => ({ agent_id, ...v })));
    }
    if (a === 'identities' && parts.length === 2) {
      const v = state.identities[b];
      return v ? send(res, 200, { agent_id: b, ...v }) : sendErr(res, 404, 'not_found', 'no such identity');
    }

    if (a === 'proposals' && parts.length === 1) {
      return send(res, 200, Object.keys(state.proposals).map(proposalView));
    }
    if (a === 'proposals' && parts.length === 2) {
      if (!state.proposals[b]) return sendErr(res, 404, 'not_found', 'no such proposal');
      return send(res, 200, { ...proposalView(b), votes: state.votes[b] || {} });
    }

    if (a === 'blocks' && parts.length === 1) {
      const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : -1;
      if (!Number.isInteger(since)) return sendErr(res, 400, 'bad_request', '`since` must be an integer');
      const out = [];
      for (let h = Math.max(since + 1, 0); h < store.blocks.length && out.length < 100; h++) {
        out.push({ hash: store.getBlockHash(h), block: store.getBlock(h) });
      }
      return send(res, 200, out);
    }
    if (a === 'block' && parts.length === 2) {
      const h = Number(b);
      const blk = Number.isInteger(h) ? store.getBlock(h) : null;
      return blk ? send(res, 200, { hash: store.getBlockHash(h), block: blk }) : sendErr(res, 404, 'not_found', 'no such block');
    }

    if (a === 'tx' && parts.length === 2) {
      const st = sequencer.txStatus(b);
      return st ? send(res, 200, { hash: b, ...st }) : sendErr(res, 404, 'not_found', 'unknown transaction');
    }

    return sendErr(res, 404, 'not_found', 'no such route');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[server] error:', e);
      if (!res.headersSent) sendErr(res, 500, 'internal', 'internal error');
    });
  });
}
