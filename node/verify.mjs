// Independent verifier: re-executes <DATA_DIR>/blocks.jsonl from <DATA_DIR>/genesis.json and
// prints the recomputed head. Exits non-zero if any block fails (bad link, bad tx, bad root).
// Usage: node node/verify.mjs [DATA_DIR] [MAX_HEIGHT]   (MAX_HEIGHT: stop the replay at that height)
import { replayFromDisk, DEFAULT_DATA_DIR } from './store.mjs';

try {
  const r = replayFromDisk(process.argv[2] || process.env.DATA_DIR || DEFAULT_DATA_DIR, process.argv[3] === undefined ? Infinity : Number(process.argv[3]));
  console.log(JSON.stringify(r));
  process.exit(r.state_root === r.recorded_state_root ? 0 : 2);
} catch (e) {
  console.error('VERIFY FAILED: ' + e.message);
  process.exit(1);
}
