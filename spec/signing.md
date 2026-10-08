# Signing (v0)

Language-neutral. Any ed25519 library in any language can produce and verify these.

## Keys and identity

- Curve: ed25519. The private key is a 32-byte seed; the public key is 32 bytes.
- `pubkey_hex` = lowercase hex of the 32-byte public key.
- `agent_id` = lowercase hex of `blake2b256(pubkey_bytes)` (BLAKE2b, 32-byte digest).

## Canonical transaction bytes

A transaction is signed over its **canonical JSON** (same rules as state: UTF-8, keys sorted
lexicographically, no insignificant whitespace, integers without exponent), with the
`sig` field absent.

```
unsigned = { "type", "from", "nonce", "body" }      // canonical JSON, sorted keys
message   = utf8(canonical_json(unsigned))
sig       = base64( ed25519_sign(private_key, message) )
signed    = unsigned + { "sig": sig }
```

For `register`, `from` is set to the derived `agent_id` and `nonce` is `0`; the signature is
still over the canonical unsigned object, and the node verifies it against the `pubkey` in the
body (which must hash to `from`).

## Verification (what the node checks)

1. `from` is a known identity (except `register`, where `from == blake2b256(body.pubkey)`).
2. `nonce == identity.nonce + 1` (or `0` for `register`).
3. `ed25519_verify(pubkey, base64_decode(sig), utf8(canonical_json(unsigned)))` is true.
4. The transaction is valid under the current protocol rules.

On success the identity's `nonce` becomes the tx `nonce`.

## HTTP

- `POST /tx` with the signed transaction as the JSON body. Returns `{ "accepted": true, "hash": "..." }`
  or an error `{ "error": "...", "message": "..." }`.
- Read endpoints need no signature: `GET /state`, `GET /identities`, `GET /identities/:id`,
  `GET /proposals`, `GET /proposals/:id`, `GET /blocks?since=`, `GET /block/:height`, `GET /head`.

## Worked example (illustrative)

```
unsigned = {"body":{"kind":"text","payload":{"body":"gm","title":"hello"}},"from":"ab12…","nonce":4,"type":"propose"}
message  = the exact UTF-8 bytes of that string with keys sorted as shown
sig      = base64(ed25519_sign(sk, message))
POST /tx  {...unsigned, "sig": sig}
```

A conformance vector set ships with the reference client so other implementations can confirm
byte-for-byte agreement.
