// Shared crypto: blake2b-256, ed25519 (sync), agent ids, transaction signing.
// Used by BOTH the node and the client so they agree byte-for-byte (spec/signing.md).
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { canonicalBytes } from './canon.mjs';

ed.hashes.sha512 = sha512;

const enc = new TextEncoder();

// Portable (no Buffer): this file runs unchanged in Node and in the browser.
export function bytesToHex(b) {
  let s = '';
  for (const x of b) s += (x < 16 ? '0' : '') + x.toString(16);
  return s;
}

function bytesToBase64(b) {
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}

function base64ToBytes(s) {
  const bin = atob(s); // throws on invalid base64
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const HEX_RE = /^(?:[0-9a-f]{2})*$/;
export function isLowerHex(s, byteLen) {
  return typeof s === 'string' && HEX_RE.test(s) && (byteLen === undefined || s.length === byteLen * 2);
}

export function hexToBytes(hex) {
  if (!isLowerHex(hex)) throw new TypeError('expected lowercase hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** blake2b with a 32-byte digest, lowercase hex. Accepts bytes or a string (UTF-8). */
export function blake2b256hex(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  return bytesToHex(blake2b(bytes, { dkLen: 32 }));
}

export function agentIdFromPubkeyHex(pubkeyHex) {
  return blake2b256hex(hexToBytes(pubkeyHex));
}

// ---- keys -------------------------------------------------------------------------------

export function pubkeyHexFromSeedHex(seedHex) {
  return bytesToHex(ed.getPublicKey(hexToBytes(seedHex)));
}

export function keypairFromSeedHex(seedHex) {
  const pubkey = pubkeyHexFromSeedHex(seedHex);
  return { seed: seedHex, pubkey, agent_id: agentIdFromPubkeyHex(pubkey) };
}

export function keygen() {
  return keypairFromSeedHex(bytesToHex(ed.utils.randomSecretKey()));
}

// ---- raw sign / verify ------------------------------------------------------------------

/** ed25519 sign; returns base64 signature. */
export function signBase64(seedHex, messageBytes) {
  return bytesToBase64(ed.sign(messageBytes, hexToBytes(seedHex)));
}

/** ed25519 verify (RFC 8032 strict branch of noble). Never throws; returns boolean. */
export function verifyBase64(pubkeyHex, sigB64, messageBytes) {
  try {
    if (typeof sigB64 !== 'string') return false;
    const sig = base64ToBytes(sigB64);
    if (sig.length !== 64 || bytesToBase64(sig) !== sigB64) return false; // canonical base64 only
    return ed.verify(sig, messageBytes, hexToBytes(pubkeyHex), { zip215: false });
  } catch {
    return false;
  }
}

// ---- transactions -----------------------------------------------------------------------

/** The exact bytes that are signed: utf8(canonical_json({type, from, nonce, body})). */
export function txMessageBytes(tx) {
  const { type, from, nonce, body } = tx;
  return canonicalBytes({ type, from, nonce, body });
}

/** Build + sign a transaction. `unsigned` = {type, from, nonce, body}. */
export function signTx(seedHex, unsigned) {
  const { type, from, nonce, body } = unsigned;
  const u = { type, from, nonce, body };
  return { ...u, sig: signBase64(seedHex, txMessageBytes(u)) };
}

/** Verify a signed tx against a given pubkey. */
export function verifyTxSignature(tx, pubkeyHex) {
  return verifyBase64(pubkeyHex, tx.sig, txMessageBytes(tx));
}

export function txHash(signedTx) {
  return blake2b256hex(canonicalBytes(signedTx));
}
