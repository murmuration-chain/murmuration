// Boots the node: genesis (genesis/params.json + genesis/charter.md) -> store -> sequencer -> HTTP.
// Env: PORT (8645), DATA_DIR (./.data), BLOCK_INTERVAL_SECONDS, VOTING_WINDOW_BLOCKS
// The two overrides apply ONLY when a fresh data dir is created (they become part of that
// chain's persisted genesis.json); they exist for fast local tests.
import { pathToFileURL } from 'node:url';
import { Store, DEFAULT_DATA_DIR } from './store.mjs';
import { Sequencer } from './sequencer.mjs';
import { createServer } from './server.mjs';

export function startNode({ port = 8645, dataDir = DEFAULT_DATA_DIR, blockIntervalSeconds, votingWindowBlocks, host = '127.0.0.1' } = {}) {
  const overrides = {};
  if (blockIntervalSeconds !== undefined) overrides.block_interval_seconds = blockIntervalSeconds;
  if (votingWindowBlocks !== undefined) overrides.voting_window_blocks = votingWindowBlocks;

  const store = new Store(dataDir);
  store.load(overrides);
  const sequencer = new Sequencer(store);
  // M2: sequencer.onBlock(anchorHook)  -- see anchor/README.md
  const server = createServer({ store, sequencer });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      sequencer.start();
      resolve({ store, sequencer, server, port: server.address().port, stop: () => { sequencer.stop(); server.close(); } });
    });
  });
}

const num = (v) => (v === undefined || v === '' ? undefined : Number(v));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const node = await startNode({
    port: num(process.env.PORT) ?? 8645,
    dataDir: process.env.DATA_DIR || DEFAULT_DATA_DIR,
    blockIntervalSeconds: num(process.env.BLOCK_INTERVAL_SECONDS),
    votingWindowBlocks: num(process.env.VOTING_WINDOW_BLOCKS),
  });
  const h = node.store.head();
  console.log(`[node] ${h.chain_id} listening on http://127.0.0.1:${node.port}`);
  console.log(`[node] data dir ${node.store.dataDir}; head height ${h.height}; state_root ${h.state_root}`);
  console.log(`[node] block interval ${node.store.state.params.block_interval_seconds}s; voting window ${node.store.state.params.voting_window_blocks} blocks`);
  const shutdown = () => { node.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
