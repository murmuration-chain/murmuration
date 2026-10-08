// Browser-and-Node ledger helper used by the page (app.js) AND by smoke.mjs, so the
// smoke test exercises the exact build -> sign -> POST /tx path the browser runs.
// Signing is the node's own code: ../common/crypto.mjs (served at /common/crypto.mjs).
import { keygen, keypairFromSeedHex, signTx } from '../common/crypto.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LedgerError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

export { keygen, keypairFromSeedHex };

export class Ledger {
  /** @param {string} base  '' for same-origin (browser) or 'http://127.0.0.1:8645' */
  constructor(base = '', key = null) {
    this.base = base.replace(/\/+$/, '');
    this.key = key;
    this._nextNonce = 0; // local counter so rapid back-to-back txs do not reuse a nonce
  }

  async _json(path, init) {
    const res = await fetch(this.base + path, init);
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new LedgerError(data?.error ?? 'http_' + res.status, data?.message ?? res.statusText, res.status);
    return data;
  }

  getState() { return this._json('/state'); }
  getIdentity(id = this.key.agent_id) { return this._json('/identities/' + id); }
  getTx(hash) { return this._json('/tx/' + hash); }

  /** Poll until the tx is in a block (resolves) or rejected/timed out (throws). */
  async waitForTx(hash, { timeoutMs = 60000, pollMs = 400 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await this.getTx(hash).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
      if (st?.status === 'included') return st;
      if (st?.status === 'rejected') throw new LedgerError(st.error, st.message);
      if (Date.now() > deadline) throw new LedgerError('timeout', 'The ledger has not confirmed this yet. Check back in a moment.');
      await sleep(pollMs);
    }
  }

  async _submit(tx) {
    return this._json('/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tx) });
  }

  /** register: from = derived agent_id, nonce 0, body.pubkey. */
  async register({ wait = true } = {}) {
    const tx = signTx(this.key.seed, { type: 'register', from: this.key.agent_id, nonce: 0, body: { pubkey: this.key.pubkey } });
    const sub = await this._submit(tx);
    this._nextNonce = 1;
    return wait ? { ...sub, ...(await this.waitForTx(sub.hash)) } : sub;
  }

  /** Any non-register tx: nonce = max(confirmed nonce + 1, local counter). */
  async send(type, body, { wait = true } = {}) {
    let confirmed = -1;
    try { confirmed = (await this.getIdentity()).nonce; } catch (e) { if (e.status !== 404) throw e; }
    const nonce = Math.max(confirmed + 1, this._nextNonce);
    const tx = signTx(this.key.seed, { type, from: this.key.agent_id, nonce, body });
    let sub;
    try { sub = await this._submit(tx); } catch (e) { if (e.code === 'bad_nonce') this._nextNonce = 0; throw e; }
    this._nextNonce = nonce + 1;
    return wait ? { ...sub, ...(await this.waitForTx(sub.hash)) } : sub;
  }

  propose(kind, payload, o) { return this.send('propose', { kind, payload }, o); }
  vote(proposalId, choice, o) { return this.send('vote', { proposal_id: Number(proposalId), choice }, o); }
  enact(proposalId, o) { return this.send('enact', { proposal_id: Number(proposalId) }, o); }
}
