// Murmuration web UI. Vanilla ES modules, no build step.
// All writes are built and signed here in the browser with the node's own common/ code
// (via ledger.mjs), then POSTed to /tx on the same origin.
import { Ledger, LedgerError, keygen, keypairFromSeedHex } from './ledger.mjs';

const $ = (id) => document.getElementById(id);
const KEY_STORE = 'murmuration.key.v1';
const POLL_MS = 3000;

// ---- small helpers ----------------------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const short = (id) => id.slice(0, 8) + '…' + id.slice(-4);

function fmtDuration(sec) {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} sec`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} hr`;
  return `${Math.round(sec / 86400)} days`;
}

function toast(msg, kind = 'info', ms = 5000) {
  const t = h('div', { class: 'toast ' + kind, role: kind === 'err' ? 'alert' : 'status' }, msg);
  $('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

const ERRORS = {
  already_registered: 'This key is already a member.',
  unknown_identity: 'Join the assembly first. This key is not registered yet.',
  insufficient_standing: 'You need a bit more standing before you can propose.',
  invalid_payload: 'The ledger did not accept that proposal. Check the values.',
  proposal_closed: 'Voting on this proposal has closed.',
  not_eligible: 'You joined after this proposal opened, so you can vote on the next one.',
  already_voted: 'You already voted on this proposal.',
  voting_open: 'Voting is still open on this proposal.',
  bad_nonce: 'Out of step with the ledger. Please try again.',
  duplicate: 'That action was already sent.',
};
const friendly = (e) => (e instanceof LedgerError ? ERRORS[e.code] || e.message : 'Could not reach the ledger. ' + (e?.message || ''));

// Plain-language names for the governance settings. Unknown ones fall back to the raw key.
const PARAM_INFO = {
  voting_window_blocks: { label: 'Voting window', unit: 'blocks', desc: 'How many blocks a proposal stays open for voting.', hint: 'Whole number, 1 or more.' },
  quorum: { label: 'Quorum', desc: 'Share of members that must vote yes or no for a result to count.', hint: 'A number from 0 to 1 (0.33 means one third).', pct: true },
  threshold: { label: 'Passing threshold', desc: 'Share of yes votes (of yes + no) needed to pass.', hint: 'A number from 0 to 1 (0.6 means 60%).', pct: true },
  min_standing_to_propose: { label: 'Standing to propose', desc: 'Minimum standing a member needs before proposing.', hint: 'Whole number, 0 or more.' },
  anchor_interval_blocks: { label: 'Anchor interval', unit: 'blocks', desc: 'How often the ledger is anchored to Cardano.', hint: 'Whole number, 1 or more.' },
  block_interval_seconds: { label: 'Block time', unit: 'seconds', desc: 'How often a new block is made.', hint: 'A number greater than 0.' },
  max_txs_per_block: { label: 'Max actions per block', desc: 'Upper limit of actions in one block.', hint: 'Whole number, 1 or more.' },
  max_tx_bytes: { label: 'Max action size', unit: 'bytes', desc: 'Largest single action the ledger accepts.', hint: 'Whole number, 1 or more.' },
};
const pinfo = (k) => PARAM_INFO[k] || { label: k, desc: '', hint: 'Must match the type of the current value.' };

// ---- key + ledger ------------------------------------------------------------------------

const ledger = new Ledger('');
let state = null;
let busy = false;

function loadKey() {
  try {
    const k = JSON.parse(localStorage.getItem(KEY_STORE) || 'null');
    if (k?.seed) return keypairFromSeedHex(k.seed);
  } catch { /* ignore */ }
  return null;
}
function saveKey(key) {
  try { localStorage.setItem(KEY_STORE, JSON.stringify({ seed: key.seed, pubkey: key.pubkey, agent_id: key.agent_id })); } catch {
    toast('This browser would not let us save your key. Please download the backup now.', 'err', 9000);
  }
}
const backupText = (key) => JSON.stringify({ murmuration: 1, seed: key.seed, pubkey: key.pubkey, agent_id: key.agent_id }, null, 2);

function parseBackup(text) {
  const t = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  try { const o = JSON.parse(t); if (typeof o.seed === 'string' && /^[0-9a-fA-F]{64}$/.test(o.seed)) return o.seed.toLowerCase(); } catch { /* fallthrough */ }
  throw new Error('That does not look like a Murmuration key backup.');
}

const myId = () => ledger.key?.agent_id;
const me = () => (state && myId() ? state.identities[myId()] : null);

// ---- actions ----------------------------------------------------------------------------

async function run(label, fn, okMsg) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach((b) => (b.disabled = true));
  toast(label + '…', 'info', 2500);
  try {
    const r = await fn();
    toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
    await refresh();
    return r;
  } catch (e) {
    toast(friendly(e), 'err', 8000);
    await refresh().catch(() => {});
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((b) => (b.disabled = false));
    render();
  }
}

async function register() {
  return run('Joining the assembly', () => ledger.register(), 'Welcome. You are now a member.');
}

$('btn-join').addEventListener('click', async () => {
  if (!ledger.key) {
    const key = keygen();
    saveKey(key);
    ledger.key = key;
    toast('Your key was created in this browser. Download a backup below.', 'info', 7000);
  }
  await register();
  const el = $('me'); el.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('btn-finish').addEventListener('click', register);

$('btn-show-import').addEventListener('click', () => $('import-box').classList.toggle('hidden'));
$('btn-import').addEventListener('click', async () => {
  try {
    const key = keypairFromSeedHex(parseBackup($('import-text').value));
    saveKey(key);
    ledger.key = key;
    $('import-text').value = '';
    await refresh();
    toast(state?.identities[key.agent_id] ? 'Welcome back. Your key is loaded.' : 'Key loaded. Press "Finish joining" to register it.', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  render();
});

$('btn-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(backupText(ledger.key)); toast('Backup copied. Paste it somewhere safe.', 'ok'); }
  catch { toast('Could not copy automatically. Use the download button instead.', 'err'); }
});
$('btn-download').addEventListener('click', () => {
  const a = h('a', { href: URL.createObjectURL(new Blob([backupText(ledger.key)], { type: 'application/json' })), download: `murmuration-key-${short(myId()).replace('…', '-')}.json` });
  document.body.append(a); a.click(); a.remove();
  toast('Backup downloaded. Keep it private.', 'ok');
});
$('btn-forget').addEventListener('click', () => {
  if (!confirm('Remove the key from this browser? Without a backup you will lose this membership.')) return;
  try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
  ledger.key = null; ledger._nextNonce = 0;
  toast('Signed out of this browser.', 'info');
  render();
});

function vote(pid, choice) {
  return run('Casting your vote', () => ledger.vote(pid, choice), `Your vote (${choice}) is recorded.`);
}
function enact(pid) {
  return run('Counting the votes', () => ledger.enact(pid), (r) => {
    const o = r.result?.outcome || r.result?.state;
    return o === 'enacted' ? 'The proposal passed and took effect.' : o === 'failed' ? 'Votes counted: the proposal did not pass.' : 'Done.';
  });
}

// ---- propose form -----------------------------------------------------------------------

function syncKind() {
  const k = $('kind').value;
  $('f-text').classList.toggle('hidden', k !== 'text');
  $('f-param').classList.toggle('hidden', k !== 'set_param');
  $('f-charter').classList.toggle('hidden', k !== 'amend_charter');
  if (k === 'amend_charter' && !$('c-text').value && state) $('c-text').value = state.charter.text;
}
function syncParam() {
  const key = $('p-key').value;
  const i = pinfo(key);
  const cur = state?.params[key];
  $('p-desc').textContent = `${i.label}${cur !== undefined ? ` is currently ${cur}${i.unit ? ' ' + i.unit : ''}` : ''}. ${i.desc}`;
  $('p-hint').textContent = i.hint;
}
$('kind').addEventListener('change', syncKind);
$('p-key').addEventListener('change', syncParam);

function parseValue(raw) {
  const t = raw.trim();
  if (t === '') throw new Error('Enter a new value.');
  try { return JSON.parse(t); } catch { throw new Error('The value must be a number.'); }
}

$('propose-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!ledger.key || !me()) return toast('Join the assembly first.', 'err');
  const kind = $('kind').value;
  let payload;
  try {
    if (kind === 'text') {
      const title = $('t-title').value.trim(), body = $('t-body').value.trim();
      if (!title) throw new Error('Give your proposal a title.');
      payload = { title, body };
    } else if (kind === 'set_param') {
      payload = { key: $('p-key').value, value: parseValue($('p-val').value) };
    } else {
      const text = $('c-text').value;
      if (!text.trim()) throw new Error('The charter cannot be empty.');
      payload = { text };
    }
  } catch (e) { return toast(e.message, 'err'); }
  const r = await run('Submitting your proposal', () => ledger.propose(kind, payload), (res) => `Proposal #${res.result?.proposal_id ?? ''} is open for voting.`);
  if (r) { $('t-title').value = ''; $('t-body').value = ''; $('p-val').value = ''; if (kind === 'amend_charter') $('c-text').value = ''; }
});

// ---- rendering --------------------------------------------------------------------------

function proposalInfo(p) {
  if (p.kind === 'text') return { title: p.payload.title, body: p.payload.body };
  if (p.kind === 'set_param') {
    const i = pinfo(p.payload.key);
    const cur = state.params[p.payload.key];
    const applied = p.result?.applied;
    return {
      title: `Change "${i.label}" to ${p.payload.value}${i.unit ? ' ' + i.unit : ''}`,
      body: `${applied ? `It was ${applied.old} and is now ${applied.new}.` : `Currently ${cur}${i.unit ? ' ' + i.unit : ''}.`} ${i.desc}`,
    };
  }
  return { title: 'Rewrite the charter', body: null, charter: p.payload.text };
}

function phase(p) {
  const nextH = state.height + 1; // a tx sent now lands in the next block
  if (p.state !== 'open') {
    if (p.state === 'enacted') return { badge: ['ok', p.kind === 'text' ? 'Passed' : 'Passed and applied'], phase: 'done' };
    return { badge: ['bad', 'Did not pass'], phase: 'done' };
  }
  if (nextH < p.closes_at) return { badge: ['open', 'Open for voting'], phase: 'voting' };
  return { badge: ['wait', 'Voting closed, awaiting count'], phase: 'count' };
}

function renderProposal(p) {
  const interval = state.params.block_interval_seconds || 5;
  const info = proposalInfo(p);
  const ph = phase(p);
  const t = p.tally;
  const total = Math.max(1, t.yes + t.no + t.abstain);
  const my = state.votes[p.id]?.[myId()];
  const mem = me();
  const eligible = mem && mem.registered_at <= p.opened_at;
  const left = p.closes_at - (state.height + 1);

  const kids = [
    h('div', { class: 'prop-head' }, h('span', { class: 'num' }, '#' + p.id), h('h3', {}, info.title), h('span', { class: 'badge ' + ph.badge[0] }, ph.badge[1])),
  ];
  if (info.body) kids.push(h('div', { class: 'body' }, info.body));
  if (info.charter) kids.push(h('details', {}, h('summary', {}, 'Read the proposed charter'), h('div', { class: 'charter' }, info.charter)));
  kids.push(h('div', { class: 'bar', title: `${t.yes} yes, ${t.no} no, ${t.abstain} abstain` },
    h('i', { class: 'y', style: `width:${(t.yes / total) * 100}%` }), h('i', { class: 'n', style: `width:${(t.no / total) * 100}%` }), h('i', { class: 'a', style: `width:${(t.abstain / total) * 100}%` })));
  kids.push(h('div', { class: 'tally' }, h('span', {}, `Yes ${t.yes}`), h('span', {}, `No ${t.no}`), h('span', {}, `Abstain ${t.abstain}`), h('span', {}, `${t.yes + t.no + t.abstain} of ${t.eligible} eligible voted`)));

  let meta;
  if (ph.phase === 'voting') meta = `${left} block${left === 1 ? '' : 's'} left (about ${fmtDuration(left * interval)}). Window: blocks ${p.opened_at} to ${p.closes_at}.`;
  else if (ph.phase === 'count') meta = `Window closed at block ${p.closes_at}. Anyone can press the button to count the votes.`;
  else {
    const r = p.result;
    meta = `Decided at block ${r?.decided_at ?? '?'}.` + (r?.reason === 'quorum_not_met' ? ' Not enough members voted (quorum not met).' : r?.reason === 'threshold_not_met' ? ' Not enough yes votes (threshold not met).' : '');
  }
  kids.push(h('div', { class: 'meta' }, meta + ` Proposed by ${p.proposer === myId() ? 'you' : short(p.proposer)}.`));

  if (ph.phase === 'voting') {
    if (!ledger.key || !mem) kids.push(h('div', { class: 'meta' }, 'Join the assembly to vote.'));
    else if (my) kids.push(h('div', { class: 'meta' }, h('b', {}, `You voted ${my}.`)));
    else if (!eligible) kids.push(h('div', { class: 'meta' }, 'You joined after this opened, so you can vote on the next one.'));
    else kids.push(h('div', { class: 'actions' },
      h('button', { class: 'yes', onclick: () => vote(p.id, 'yes') }, 'Yes'),
      h('button', { class: 'no', onclick: () => vote(p.id, 'no') }, 'No'),
      h('button', { class: 'abs', onclick: () => vote(p.id, 'abstain') }, 'Abstain')));
  } else if (ph.phase === 'count') {
    if (!ledger.key || !mem) kids.push(h('div', { class: 'meta' }, 'Join the assembly to press the count button.'));
    else kids.push(h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => enact(p.id) }, 'Count the votes and finish')));
  }
  return h('div', { class: 'prop' }, kids);
}

function render() {
  const key = ledger.key;
  const mem = me();
  // join / me panels
  $('join').classList.toggle('hidden', !!mem);
  $('btn-join').textContent = key && !mem ? 'Finish joining' : 'Join the assembly';
  $('me').classList.toggle('hidden', !key);
  if (key) {
    $('me-title').textContent = mem ? 'You are in the assembly' : 'Your key is ready, but not registered yet';
    $('me-sub').textContent = mem ? `Standing ${mem.standing} · joined at block ${mem.registered_at}. Your member ID:` : 'Press "Finish joining" to register it. Your member ID:';
    $('me-id').textContent = key.agent_id;
    $('btn-finish').classList.toggle('hidden', !!mem);
  }
  $('propose-form').classList.toggle('hidden', !mem);
  $('propose-locked').classList.toggle('hidden', !!mem);

  if (!state) return;
  $('foot-chain').textContent = `chain ${state.chain_id}`;

  // params
  $('params').replaceChildren(...Object.entries(state.params).filter(([k]) => PARAM_INFO[k]).concat(Object.entries(state.params).filter(([k]) => !PARAM_INFO[k]))
    .map(([k, v]) => { const i = pinfo(k); return h('div', { class: 'param', title: k }, h('b', {}, i.label), h('span', { class: 'v' }, String(v)), i.unit ? h('span', { class: 'd' }, ' ' + i.unit) : '', h('div', { class: 'd' }, i.desc)); }));

  // param dropdown (preserve selection)
  const keys = Object.keys(state.params);
  const sel = $('p-key');
  if (sel.options.length !== keys.length || keys.some((k, i) => sel.options[i].value !== k)) {
    const prev = sel.value;
    sel.replaceChildren(...keys.map((k) => h('option', { value: k }, `${pinfo(k).label} (now ${state.params[k]})`)));
    if (keys.includes(prev)) sel.value = prev;
  } else keys.forEach((k, i) => { const t = `${pinfo(k).label} (now ${state.params[k]})`; if (sel.options[i].textContent !== t) sel.options[i].textContent = t; });
  syncParam();

  // charter
  $('charter').textContent = state.charter.text;
  $('charter-ver').textContent = 'version ' + state.charter.version;

  // members
  const ids = Object.keys(state.identities);
  $('member-count').textContent = ids.length;
  $('members').replaceChildren(...ids.map((id) => h('span', { class: 'member' + (id === myId() ? ' me' : ''), title: `standing ${state.identities[id].standing}` }, (id === myId() ? 'You · ' : '') + short(id))));

  // proposals: newest first, open ones on top
  const props = Object.entries(state.proposals).map(([id, p]) => ({ id: Number(id), ...p, tally: tallyOf(id, p) }));
  const rank = (p) => (p.state === 'open' ? 0 : 1);
  props.sort((a, b) => rank(a) - rank(b) || b.id - a.id);
  $('proposals').replaceChildren(...(props.length ? props.map(renderProposal) : [h('div', { class: 'empty' }, 'No proposals yet. Be the first to make one below.')]));
  const open = props.filter((p) => p.state === 'open').length;
  $('prop-sub').textContent = `${open} open · ${props.length - open} decided. Voting is one member, one vote.`;
}

function tallyOf(id, p) {
  const t = { yes: 0, no: 0, abstain: 0, eligible: 0 };
  for (const c of Object.values(state.votes[id] || {})) t[c]++;
  for (const m of Object.values(state.identities)) if (m.registered_at <= p.opened_at) t.eligible++;
  return t;
}

async function refresh() {
  try {
    state = await ledger.getState();
    $('status').className = 'pill live';
    $('status-text').textContent = `live · block ${state.height}`;
  } catch {
    $('status').className = 'pill off';
    $('status-text').textContent = 'cannot reach the ledger';
    return;
  }
  if (!busy) render();
}

// ---- boot -------------------------------------------------------------------------------

ledger.key = loadKey();
syncKind();
render();
await refresh();
syncKind();
setInterval(() => { if (!busy && !document.hidden) refresh(); }, POLL_MS);
