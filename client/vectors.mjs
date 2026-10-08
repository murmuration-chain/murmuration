// Conformance vectors for implementers in other languages (spec/signing.md).
// Every value below is fixed. `checkVectors()` re-derives each one with the shared
// common/ code and reports mismatches; `node client/vectors.mjs` prints PASS/FAIL per vector.
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '../common/canon.mjs';
import {
  pubkeyHexFromSeedHex, agentIdFromPubkeyHex, blake2b256hex, signBase64, verifyBase64,
  txMessageBytes, signTx, verifyTxSignature, txHash,
} from '../common/crypto.mjs';

export const VECTORS = {
  // 1. Raw ed25519: RFC 8032 section 7.1, TEST 1 (independent of this project), empty message.
  rfc8032_test1: {
    seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    pubkey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message_hex: '',
    signature_hex: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  // 2. blake2b with a 32-byte digest (unkeyed).
  blake2b256: [
    { input_utf8: '', hash: '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8' },
    { input_utf8: 'abc', hash: 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319' },
  ],
  // 3. Canonical JSON: sorted keys (recursive), no whitespace, raw non-ASCII, integers w/o exponent.
  canonical_json: {
    input: { z: 1, a: { y: [3, 2, 1], b: null }, m: 'héllo "q"\n', f: 0.55, t: true },
    output: '{"a":{"b":null,"y":[3,2,1]},"f":0.55,"m":"héllo \\"q\\"\\n","t":true,"z":1}',
  },
  // 4. A full signed transaction (seed 0x01 * 32).
  signed_tx: {
    seed: '0101010101010101010101010101010101010101010101010101010101010101',
    pubkey: '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c',
    agent_id: 'c5e21ab1c9f6022d81c3b25e3436cb7f1df77f9652ae3e1310c28e621dd87b4c',
    register: {
      unsigned: { type: 'register', from: 'c5e21ab1c9f6022d81c3b25e3436cb7f1df77f9652ae3e1310c28e621dd87b4c', nonce: 0, body: { pubkey: '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c' } },
      message_utf8: '{"body":{"pubkey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"},"from":"c5e21ab1c9f6022d81c3b25e3436cb7f1df77f9652ae3e1310c28e621dd87b4c","nonce":0,"type":"register"}',
      sig: 'pMkR4GS817B57tUT0c+jJCvnCv6b8xiHtbBil0+wiuiV54jDLvTmoYghwLhGaIkvWfsVkAFY6EZkm2TCnxshBw==',
      tx_hash: '52f3c57b587314d39548627cc74b0201c4d0a283f3f3becccb6090f71b7c82d7',
    },
    propose: {
      unsigned: { type: 'propose', from: 'c5e21ab1c9f6022d81c3b25e3436cb7f1df77f9652ae3e1310c28e621dd87b4c', nonce: 1, body: { kind: 'set_param', payload: { key: 'threshold', value: 0.55 } } },
      message_utf8: '{"body":{"kind":"set_param","payload":{"key":"threshold","value":0.55}},"from":"c5e21ab1c9f6022d81c3b25e3436cb7f1df77f9652ae3e1310c28e621dd87b4c","nonce":1,"type":"propose"}',
      sig: 'mFDFM6oDSPg119aM2NJ8oCD2BflincJ49n1bexIHeXw8eS//av8J/o6Rjvka+IEr52XXi2iFfIQsRTc8VyiODw==',
      tx_hash: '6b97d625324df28d278f1e5d73e56acc97a9afb74a481f6e549d5bfe8b7ddfb6',
    },
  },
  // 5. state_root of a literal tiny state: blake2b256hex(canonical_json(state)).
  state_root: {
    state: { chain_id: 'vec', protocol_version: 0, height: 0, identities: {}, params: { quorum: 0.33 }, charter: { version: 0, text: 'x' }, proposals: {}, votes: {}, next_proposal_id: 1 },
    root: '04be2069c630ba438c4f931f0af6e63195848b1ba668d4b8cb48e131b8901732',
  },
};

/** Re-derive every vector; returns [{name, ok, detail?}]. */
export function checkVectors(V = VECTORS) {
  const out = [];
  const t = (name, ok, detail) => out.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
  const hex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

  const r = V.rfc8032_test1;
  t('rfc8032 seed -> pubkey', pubkeyHexFromSeedHex(r.seed) === r.pubkey, pubkeyHexFromSeedHex(r.seed));
  const rsig = Buffer.from(signBase64(r.seed, hex(r.message_hex)), 'base64').toString('hex');
  t('rfc8032 sign(empty) == RFC signature', rsig === r.signature_hex, rsig);
  t('rfc8032 verify', verifyBase64(r.pubkey, Buffer.from(r.signature_hex, 'hex').toString('base64'), hex(r.message_hex)));

  for (const b of V.blake2b256) t(`blake2b256(${JSON.stringify(b.input_utf8)})`, blake2b256hex(b.input_utf8) === b.hash, blake2b256hex(b.input_utf8));

  t('canonical json example', canonicalJson(V.canonical_json.input) === V.canonical_json.output, canonicalJson(V.canonical_json.input));

  const s = V.signed_tx;
  t('signed_tx seed -> pubkey', pubkeyHexFromSeedHex(s.seed) === s.pubkey, pubkeyHexFromSeedHex(s.seed));
  t('signed_tx pubkey -> agent_id', agentIdFromPubkeyHex(s.pubkey) === s.agent_id, agentIdFromPubkeyHex(s.pubkey));
  for (const name of ['register', 'propose']) {
    const v = s[name];
    const msg = Buffer.from(txMessageBytes(v.unsigned)).toString('utf8');
    t(`${name}: message bytes`, msg === v.message_utf8, msg);
    const signed = signTx(s.seed, v.unsigned);
    t(`${name}: signature`, signed.sig === v.sig, signed.sig);
    t(`${name}: verifies`, verifyTxSignature({ ...v.unsigned, sig: v.sig }, s.pubkey));
    t(`${name}: tx hash`, txHash({ ...v.unsigned, sig: v.sig }) === v.tx_hash, txHash({ ...v.unsigned, sig: v.sig }));
    const tampered = { ...v.unsigned, nonce: v.unsigned.nonce + 1, sig: v.sig };
    t(`${name}: tampered tx rejected`, !verifyTxSignature(tampered, s.pubkey));
  }

  const root = blake2b256hex(canonicalJson(V.state_root.state));
  t('state_root of literal state', root === V.state_root.root, root);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = checkVectors();
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.detail}`);
  const bad = res.filter((r) => !r.ok).length;
  console.log(bad ? `${bad} FAILED` : `all ${res.length} vectors OK`);
  process.exit(bad ? 1 : 0);
}
