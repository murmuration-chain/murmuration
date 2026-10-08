// Reference client. Thin on purpose: key handling, canonical signing (shared common/ code),
// submitTx, read helpers, and convenience wrappers for the four tx types.
import fs from 'node:fs';
import { keygen, keypairFromSeedHex, signTx } from '../common/crypto.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LedgerError extends Error {
  constructor(code, message, status) {
    super(`${code}: ${message}`);
    this.code = code;
    this.status = status;
  }
}

export class LedgerClient {
  /**
   * @param {object} o
   * @param {string} o.url   node base URL, e.g. http://127.0.0.1:8645
   * @param {{seed:string,pubkey:string,agent_id:string}} [o.key]  keypair (see loadKey/generateKey)
   */
  constructor({ url, key } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.key = key ?? null;
    this._nextNonce = null; // local nonce counter so back-to-back txs don't race the block interval
  }

  // ---- keys ----------------------------------------------------------------------------
  static generateKey() { return keygen(); }
  static keyFromSeed(seedHex) { return keypairFromSeedHex(seedHex); }
  static saveKey(path, key) {
    fs.writeFileSync(path, JSON.stringify({ seed: key.seed, pubkey: key.pubkey, agent_id: key.agent_id }, null, 2) + '\n', { mode: 0o600 });
  }
  static loadKey(path) {
    const k = JSON.parse(fs.readFileSync(path, 'utf8'));
    return keypairFromSeedHex(k.seed);
  }
  get agentId() { return this.key.agent_id; }

  // ---- http ----------------------------------------------------------------------------
  async _get(path) {
    const res = await fetch(this.url + path);
    const data = await res.json();
    if (!res.ok) throw new LedgerError(data.error ?? 'http_' + res.status, data.message ?? res.statusText, res.status);
    return data;
  }

  getHealth() { return this._get('/health'); }
  getHead() { return this._get('/head'); }
  getState() { return this._get('/state'); }
  getParams() { return this._get('/params'); }
  getCharter() { return this._get('/charter'); }
  getIdentities() { return this._get('/identities'); }
  getIdentity(id = this.agentId) { return this._get('/identities/' + id); }
  getProposals() { return this._get('/proposals'); }
  getProposal(id) { return this._get('/proposals/' + id); }
  getBlocks(since = -1) { return this._get('/blocks?since=' + since); }
  getBlock(height) { return this._get('/block/' + height); }
  getTx(hash) { return this._get('/tx/' + hash); }

  // ---- transactions ---------------------------------------------------------------------
  /** Sign {type, from, nonce, body} with this client's key. */
  sign(unsigned) { return signTx(this.key.seed, unsigned); }

  /** POST a signed tx. Returns the node's { accepted, hash, ... } or throws LedgerError. */
  async submitTx(signedTx) {
    const res = await fetch(this.url + '/tx', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signedTx),
    });
    const data = await res.json();
    if (!res.ok) throw new LedgerError(data.error ?? 'http_' + res.status, data.message ?? res.statusText, res.status);
    return data;
  }

  /** Poll until the tx is included in a block (or rejected). Resolves with its status record. */
  async waitForTx(hash, { timeoutMs = 30000, pollMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await this.getTx(hash).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
      if (st && st.status === 'included') return st;
      if (st && st.status === 'rejected') throw new LedgerError(st.error, st.message);
      if (Date.now() > deadline) throw new LedgerError('timeout', `tx ${hash} not included in ${timeoutMs}ms`);
      await sleep(pollMs);
    }
  }

  async _nonce() {
    let confirmed = -1;
    try { confirmed = (await this.getIdentity()).nonce; } catch (e) { if (e.status !== 404) throw e; }
    const n = Math.max(confirmed + 1, this._nextNonce ?? 0);
    return n;
  }

  /** Build, sign, submit a non-register tx. `wait` (default true) waits for block inclusion. */
  async send(type, body, { wait = true } = {}) {
    const nonce = await this._nonce();
    const tx = this.sign({ type, from: this.agentId, nonce, body });
    const sub = await this.submitTx(tx);
    this._nextNonce = nonce + 1;
    return wait ? { ...sub, ...(await this.waitForTx(sub.hash)) } : sub;
  }

  /** register: from = derived agent_id, nonce = 0, body.pubkey = our pubkey. */
  async register({ wait = true } = {}) {
    const tx = this.sign({ type: 'register', from: this.agentId, nonce: 0, body: { pubkey: this.key.pubkey } });
    const sub = await this.submitTx(tx);
    this._nextNonce = 1;
    return wait ? { ...sub, ...(await this.waitForTx(sub.hash)) } : sub;
  }

  propose(kind, payload, opts) { return this.send('propose', { kind, payload }, opts); }
  vote(proposalId, choice, opts) { return this.send('vote', { proposal_id: Number(proposalId), choice }, opts); }
  enact(proposalId, opts) { return this.send('enact', { proposal_id: Number(proposalId) }, opts); }

  /** Poll until the chain head reaches `height`. */
  async waitForHeight(height, { timeoutMs = 60000, pollMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const h = await this.getHead();
      if (h.height >= height) return h;
      if (Date.now() > deadline) throw new LedgerError('timeout', `head did not reach ${height}`);
      await sleep(pollMs);
    }
  }
}
