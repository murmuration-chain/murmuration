# web - the Murmuration participation page

A no-install, no-CLI UI. Run the node, open the URL, click **Join the assembly**.

```
npm run node            # http://127.0.0.1:8645/
```

## What it does
- **Join**: generates an ed25519 key in the browser (localStorage), shows a backup affordance
  (copy / download / import), derives `agent_id`, submits a `register` tx. Resumes an existing key.
- **See**: charter, settings (plain-language), members, proposals with tallies and time left
  (blocks + approximate time + the voting window).
- **Propose** (`text`, `set_param` with a dropdown of existing params, `amend_charter`),
  **Vote** (yes/no/abstain) on open proposals, **Enact** (anyone) once the window has closed.
- Toasts for success and errors. Light/dark via `prefers-color-scheme`, works at phone width.

## How signing matches the node
Nothing is re-implemented. The page imports `ledger.mjs`, which imports `../common/crypto.mjs`
and `canon.mjs`: the very files the node uses, served at `/common/*`. `common/crypto.mjs` was
made Buffer-free (portable `btoa`/`atob`/hex helpers) so one file runs in Node and the browser.
Nonce: the page reads `/identities/:id`, sends `max(nonce+1, local counter)`, then polls
`/tx/:hash` until the tx is in a block.

## @noble: served locally, no CDN, no bundler
`index.html` has an import map pointing `@noble/ed25519`, `@noble/hashes/sha2.js` and
`@noble/hashes/blake2.js` at `/vendor/@noble/...`, which `node/server.mjs` serves straight from
`node_modules/@noble/` (only `.js`). Their internal relative imports resolve naturally.

## Static routes added to node/server.mjs
`GET /` -> `web/index.html`; `/web/*`; `/common/*`; `/vendor/@noble/*`. Traversal-guarded,
extension-whitelisted content types. API and consensus untouched.

## Smoke test
```
DATA_DIR=./.data-smoke PORT=8650 VOTING_WINDOW_BLOCKS=3 BLOCK_INTERVAL_SECONDS=1 npm run node
node web/smoke.mjs http://127.0.0.1:8650
```
Registers a fresh identity with the page's own signing code, makes two proposals, votes, checks
`/state`, confirms a forged signature is rejected, and (on a short window) enacts. It also checks
that served `/common/*.mjs` are byte-identical to the node's files.

Backup warning (also shown in the UI): the key lives only in the browser. No backup, no recovery.
