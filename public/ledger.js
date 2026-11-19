/* ===================== Bitbase Ledger (admin page) =====================
   Admin-only page behind its own LEDGER password (see ledger-server.js).
   Members' X payouts in USD; money received in PKR, split by the member's fixed rate:
     20% -> 15 parts Payment Gateway + 5 parts Community Funds   15% -> all Gateway   5% -> all Community
   Pools: Payment Gateway, Account, Community Funds. Expenses (from Community Funds by default)
   and board entries (add / send / remove) move money between them. Payouts are grouped by X payout
   day; reports (one payout day, full summary) open the print window (Save as PDF).
   Everything is stored on the server; this file only shows it and sends changes.
   All names here start with lg so they never clash with app.js. */
'use strict';

const LG_POOLS = { gateway: 'Payment Gateway', account: 'Account', community: 'Community Funds' };
const LG_RATES = { 20: { gateway: 15, community: 5 }, 15: { gateway: 15 }, 5: { community: 5 } };
const LG_EXPENSE_CATEGORIES = ['Bank / transfer fee', 'Tools & software', 'Promotion', 'Prizes & rewards', 'Salary / help', 'Other'];
const LG_TABS = [['board', 'Board'], ['payouts', 'Payouts'], ['members', 'Members'], ['expenses', 'Expenses'], ['reports', 'Reports (PDF)'], ['settings', 'Settings']];

// status: null (not asked yet) | { unlocked, hasPassword };  data: what GET /api/ledger returned
// newDay: a payout day just started (no members yet); again: "Save + add next" was pressed
var lg = { status: null, data: null, loading: false, lockForm: 'unlock', newDay: null, again: false };
// "Clear" = the Payment Gateway money was sent to the payment gateway (a send to outside with this name).
const LG_CLEAR_TO = 'Payment gateway (cleared)';
function lgIsClear(m){ return m.type === 'send' && m.from === 'gateway' && m.to === 'outside' && m.recipient === LG_CLEAR_TO; }

/* ---------------- helpers ---------------- */
function lgR2(n){ return Math.round((Number(n) || 0) * 100) / 100; }
function lgPkr(n){ const v = lgR2(n); return (v < 0 ? '− ' : '') + 'Rs ' + Math.abs(v).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function lgUsd(n){ return '$' + lgR2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function lgDate(iso){ return iso ? fmtDate(iso) : '—'; }
function lgToday(){ return calendarToday(); }
function lgInRange(iso, from, to){ return (!from || iso >= from) && (!to || iso <= to); }
function lgVal(id){ const el = document.getElementById(id); return el ? el.value : ''; }
function lgMember(id){ return ((lg.data && lg.data.members) || []).find(m => m.id === id); }
function lgMemberName(p){ const m = lgMember(p.memberId); return m ? m.name : (p.memberName || '(removed member)'); }
// The Ledger only offers monetized members (anyone with an older payout still shows in history/reports).
function lgMonetized(){ return ((lg.data && lg.data.members) || []).filter(m => m.monetized); }

/* ---------------- the calculations (same rules as the server) ---------------- */
function lgSplit(receivedPkr, rate){
  const parts = LG_RATES[rate] || {};
  const total = Object.values(parts).reduce((s, v) => s + v, 0) || 1;
  const keys = Object.keys(parts);
  const out = { gateway: 0, account: 0, community: 0 };
  let used = 0;
  keys.forEach((k, i) => { out[k] = i === keys.length - 1 ? lgR2(receivedPkr - used) : lgR2(receivedPkr * parts[k] / total); used += out[k]; });
  return out;
}
// The $ part of the X payout each pool gets: e.g. $115 at 20% -> gateway 15% = $17.25, community 5% = $5.75.
function lgSplitUsd(usd, rate){
  const parts = LG_RATES[rate] || {};
  return { gateway: lgR2(usd * (parts.gateway || 0) / 100), community: lgR2(usd * (parts.community || 0) / 100) };
}
function lgPayoutSplit(p){ return p.status === 'received' ? lgSplit(p.receivedPkr, p.rate) : { gateway: 0, account: 0, community: 0 }; }
function lgGuessRate(usd, receivedPkr){
  const rate = Number(lg.data.settings.usdRate) || 0;
  if(!rate || !usd || !receivedPkr) return null;
  let best = null, bestDiff = Infinity;
  Object.keys(LG_RATES).map(Number).forEach(p => { const d = Math.abs(usd * p / 100 * rate - receivedPkr); if(d < bestDiff){ bestDiff = d; best = p; } });
  return best;
}
// Every money movement in one list (amount > 0 = into the pool).
function lgEntries(){
  const d = lg.data, out = [];
  d.payouts.filter(p => p.status === 'received').forEach(p => {
    const s = lgPayoutSplit(p);
    Object.keys(s).forEach(pool => { if(s[pool]) out.push({ date: p.receivedDate || p.date, pool, amount: s[pool], kind: 'payout', text: `${lgMemberName(p)} · ${lgUsd(p.usd)} payout · ${p.rate}%` }); });
  });
  d.moves.forEach(m => {
    if(m.type === 'add') out.push({ date: m.date, pool: m.to, amount: m.pkr, kind: 'add', text: m.note || 'Added', moveId: m.id });
    if(m.type === 'remove') out.push({ date: m.date, pool: m.from, amount: -m.pkr, kind: 'remove', text: m.note || 'Removed', moveId: m.id });
    if(m.type === 'send' && lgIsClear(m)) out.push({ date: m.date, pool: 'gateway', amount: -m.pkr, kind: 'clear', text: 'Sent to the payment gateway' + (m.note ? ' · ' + m.note : ''), moveId: m.id });
    else if(m.type === 'send'){
      out.push({ date: m.date, pool: m.from, amount: -m.pkr, kind: 'send', text: (m.to === 'outside' ? `Sent to ${m.recipient || 'outside'}` : `Sent to ${LG_POOLS[m.to]}`) + (m.note ? ' · ' + m.note : ''), moveId: m.id });
      if(m.to !== 'outside') out.push({ date: m.date, pool: m.to, amount: m.pkr, kind: 'send', text: `From ${LG_POOLS[m.from]}` + (m.note ? ' · ' + m.note : ''), moveId: m.id });
    }
  });
  d.expenses.forEach(e => out.push({ date: e.date, pool: e.pool, amount: -e.pkr, kind: 'expense', text: `${e.category}${e.note ? ' · ' + e.note : ''}`, expenseId: e.id }));
  return out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}
function lgBalances(upTo){
  const b = { gateway: 0, account: 0, community: 0 };
  lgEntries().forEach(e => { if(!upTo || e.date <= upTo) b[e.pool] = lgR2(b[e.pool] + e.amount); });
  return b;
}
function lgTotals(from, to){
  const d = lg.data;
  const pays = d.payouts.filter(p => lgInRange(p.date, from, to));
  const rec = d.payouts.filter(p => p.status === 'received' && lgInRange(p.receivedDate || p.date, from, to));
  const t = { payouts: pays.length, payoutUsd: 0, received: rec.length, receivedPkr: 0, gateway: 0, community: 0, gatewayUsd: 0, communityUsd: 0,
    pending: 0, pendingUsd: 0, expenses: 0, expensesPkr: 0, members: new Set() };
  pays.forEach(p => { t.payoutUsd += p.usd; t.members.add(p.memberId); if(p.status !== 'received'){ t.pending++; t.pendingUsd += p.usd; } });
  rec.forEach(p => { const s = lgPayoutSplit(p), su = lgSplitUsd(p.usd, p.rate); t.receivedPkr += p.receivedPkr; t.gateway += s.gateway; t.community += s.community; t.gatewayUsd += su.gateway; t.communityUsd += su.community; });
  d.expenses.filter(e => lgInRange(e.date, from, to)).forEach(e => { t.expenses++; t.expensesPkr += e.pkr; });
  return t;
}

/* ---------------- server talk ---------------- */
async function lgLoad(){
  if(lg.loading) return;
  lg.loading = true;
  try{
    lg.status = await apiGet('/ledger/status');
    lg.data = lg.status.unlocked ? await apiGet('/ledger') : null;
  }catch(err){
    if(String(err.message).includes('ledger_locked')){ lg.status = Object.assign({}, lg.status, { unlocked: false }); lg.data = null; }
    else toast(err.message, true);
  }finally{ lg.loading = false; }
  if(state.ui.view === 'ledger') render();
}
// Send a change, then reload the ledger. A 423 (unlock expired) shows the password screen again.
async function lgSend(method, path, body, okMsg){
  try{
    const res = await apiSend(method, path, body);
    lg.data = await apiGet('/ledger');
    closeModal(); render();
    if(okMsg) toast(okMsg);
    return res;
  }catch(err){
    if(err.data && err.data.error === 'ledger_locked'){ closeModal(); lg.status = { unlocked: false, hasPassword: true }; lg.data = null; render(); toast('The Ledger locked itself after 10 minutes without use. Enter the ledger password again.', true); }
    else toast(err.message, true);
    return null;
  }
}
// Called by goto() when the Ledger page is opened: reload it (fresh member list, monetized flags).
function lgOnOpen(){
  if(lg.status && lg.status.unlocked && lg.data){ lg.status = null; lg.data = null; }
}
async function lgLock(){
  try{ await apiSend('POST', '/ledger/lock'); }catch(e){}
  lg.status = { unlocked: false, hasPassword: true }; lg.data = null; lg.lockForm = 'unlock'; render();
}

/* ---------------- page ---------------- */
function renderLedgerPage(u){
  if(u.role !== 'admin') return `<div class="empty">Not available.</div>`;
  if(!lg.status){ lgLoad(); return `<div class="empty">Loading the Ledger…</div>`; }
  if(!lg.status.unlocked || !lg.data) return lgLockScreen();
  const tab = state.ui.params.lgTab || 'board';
  const body = { board: lgBoard, payouts: lgPayouts, members: lgMembers, expenses: lgExpenses, reports: lgReports, settings: lgSettings }[tab] || lgBoard;
  return `
    <div class="page-head">
      <div><h1>📒 Ledger</h1><div class="sub">X payouts in $, money received in Rs, split by each member's fixed rate · admin only</div></div>
      <div class="toolbar"><button class="btn btn-outline btn-sm" style="width:auto;" onclick="lgLock()">🔒 Lock</button></div>
    </div>
    <div class="toolbar" style="margin-bottom:16px;">
      ${LG_TABS.map(([k, l]) => `<button class="btn ${tab === k ? 'btn-primary' : 'btn-outline'} btn-sm" style="width:auto;" onclick="state.ui.params.lgTab='${k}'; render();">${l}</button>`).join('')}
    </div>
    ${body()}`;
}

/* ---------------- lock screen: set / unlock / reset ---------------- */
function lgLockScreen(){
  const first = !lg.status.hasPassword;
  const mode = first ? 'set' : lg.lockForm;
  const box = (title, sub, inner) => `<div class="card" style="max-width:420px;margin:30px auto;">
      <div style="font-size:30px;text-align:center;">🔒</div>
      <h3 style="text-align:center;margin:6px 0 4px;">${title}</h3>
      <div class="muted" style="font-size:13px;text-align:center;margin-bottom:16px;">${sub}</div>${inner}</div>`;
  if(mode === 'set') return box('Create the ledger password', 'The Ledger has its own password, separate from your login. Pick one only you know.',
    `<form onsubmit="return lgSetPassword(event,'set')">
      <div class="field"><label>Your admin login password (to confirm it's you)</label><input id="lgAcc" type="password" autocomplete="current-password" required></div>
      <div class="field"><label>New ledger password</label><input id="lgNew" type="password" autocomplete="new-password" minlength="6" required></div>
      <div class="field"><label>Type it again</label><input id="lgNew2" type="password" autocomplete="new-password" minlength="6" required></div>
      <button class="btn btn-primary">Create and open the Ledger</button></form>`);
  if(mode === 'reset') return box('Reset the ledger password', 'Forgot it? Confirm with your admin login password and choose a new one.',
    `<form onsubmit="return lgSetPassword(event,'reset')">
      <div class="field"><label>Your admin login password</label><input id="lgAcc" type="password" autocomplete="current-password" required></div>
      <div class="field"><label>New ledger password</label><input id="lgNew" type="password" autocomplete="new-password" minlength="6" required></div>
      <div class="field"><label>Type it again</label><input id="lgNew2" type="password" autocomplete="new-password" minlength="6" required></div>
      <button class="btn btn-primary">Reset and open</button></form>
      <div style="text-align:center;margin-top:12px;"><a class="muted" style="cursor:pointer;font-size:13px;" onclick="lg.lockForm='unlock'; render();">← Back</a></div>`);
  return box('The Ledger is locked', 'Enter the ledger password to open it. It locks again after 10 minutes without use.',
    `<form onsubmit="return lgUnlock(event)">
      <div class="field"><label>Ledger password</label><input id="lgPw" type="password" autocomplete="current-password" required autofocus></div>
      <button class="btn btn-primary">Open the Ledger</button></form>
      <div style="text-align:center;margin-top:12px;"><a class="muted" style="cursor:pointer;font-size:13px;" onclick="lg.lockForm='reset'; render();">Forgot the ledger password?</a></div>`);
}
async function lgUnlock(e){
  e.preventDefault();
  try{
    await apiSend('POST', '/ledger/unlock', { password: lgVal('lgPw') });
    lg.status = { unlocked: true, hasPassword: true }; lg.data = await apiGet('/ledger'); render();
  }catch(err){ toast(err.message, true); }
  return false;
}
// mode 'set' / 'reset' use the admin login password; 'change' uses the current ledger password.
async function lgSetPassword(e, mode){
  e.preventDefault();
  const np = lgVal('lgNew');
  if(np.length < 6){ toast('The ledger password must be at least 6 characters.', true); return false; }
  if(np !== lgVal('lgNew2')){ toast("The two new passwords don't match.", true); return false; }
  const body = mode === 'change' ? { currentPassword: lgVal('lgCur'), newPassword: np } : { accountPassword: lgVal('lgAcc'), newPassword: np };
  try{
    await apiSend('POST', '/ledger/password', body);
    lg.status = { unlocked: true, hasPassword: true }; lg.data = await apiGet('/ledger'); lg.lockForm = 'unlock';
    closeModal(); render();
    toast(mode === 'set' ? 'Ledger password created.' : mode === 'reset' ? 'Ledger password reset.' : 'Ledger password changed.');
  }catch(err){ toast(err.message, true); }
  return false;
}

/* ---------------- Board ---------------- */
function lgBoard(){
  const b = lgBalances(), t = lgTotals();
  const entries = lgEntries().slice().reverse().slice(0, 40);
  const cleared = lg.data.moves.filter(lgIsClear).sort((x, y) => x.date < y.date ? -1 : 1), last = cleared[cleared.length - 1];
  return `
    <div class="toolbar" style="margin-bottom:14px;">
      <button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgOpenMove('add')">↓ Add money</button>
      <button class="btn btn-outline btn-sm" style="width:auto;" onclick="lgOpenMove('send')">→ Send</button>
      <button class="btn btn-outline btn-sm" style="width:auto;" onclick="lgOpenMove('remove')">↑ Remove</button>
      <button class="btn btn-outline btn-sm" style="width:auto;" onclick="lgOpenExpense()">+ Expense</button>
    </div>
    <div class="grid-stats">
      <div class="stat-card"><div class="label">Total balance</div><div class="value blue">${lgPkr(b.gateway + b.account + b.community)}</div></div>
      ${Object.keys(LG_POOLS).map(k => `<div class="stat-card"><div class="label">${LG_POOLS[k]}</div><div class="value blue">${lgPkr(b[k])}</div>
        ${k === 'gateway' ? `${last ? `<div class="muted" style="font-size:12px;">Last cleared ${lgDate(last.date)} · ${lgPkr(last.pkr)}</div>` : ''}
          ${b.gateway > 0 ? `<button class="btn btn-outline btn-sm" style="width:auto;margin-top:8px;" onclick="lgOpenClear()" title="You sent the Payment Gateway money to the payment gateway">✔ Clear (sent)</button>` : ''}` : ''}</div>`).join('')}
    </div>
    <div class="grid-stats">
      <div class="stat-card"><div class="label">Payouts recorded</div><div class="value">${t.payouts}</div><div class="muted" style="font-size:12px;">${lgUsd(t.payoutUsd)} in X payouts</div></div>
      <div class="stat-card"><div class="label">Received</div><div class="value">${lgPkr(t.receivedPkr)}</div><div class="muted" style="font-size:12px;">${t.received} payout${t.received === 1 ? '' : 's'}</div></div>
      <div class="stat-card"><div class="label">Waiting</div><div class="value">${t.pending}</div><div class="muted" style="font-size:12px;">${lgUsd(t.pendingUsd)} not received yet</div></div>
      <div class="stat-card"><div class="label">Expenses</div><div class="value">${lgPkr(t.expensesPkr)}</div><div class="muted" style="font-size:12px;">${t.expenses} expense${t.expenses === 1 ? '' : 's'}</div></div>
    </div>
    <div class="card"><h3>Latest money movements</h3>
      ${entries.length ? `<div class="scrollx"><table class="to-cards"><thead><tr><th>Date</th><th>What</th><th>Pool</th><th>Amount</th><th></th></tr></thead><tbody>
        ${entries.map(e => `<tr><td data-label="Date">${lgDate(e.date)}</td><td data-label="What">${lgKindPill(e)} ${escapeHtml(e.text)}</td><td data-label="Pool">${LG_POOLS[e.pool]}</td>
          <td data-label="Amount" style="font-weight:700;color:${e.amount < 0 ? 'var(--danger)' : 'var(--success)'}">${e.amount < 0 ? '−' : '+'}${lgPkr(Math.abs(e.amount))}</td>
          <td data-label="">${e.moveId ? `<button class="btn btn-outline btn-sm" onclick="lgOpenMove(null,'${e.moveId}')">Edit</button>` : e.expenseId ? `<button class="btn btn-outline btn-sm" onclick="lgOpenExpense('${e.expenseId}')">Edit</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">Nothing yet. Add a payout in the Payouts tab.</div>`}
    </div>`;
}
function lgKindPill(e){
  return { payout: '<span class="lg-pill in">↓ received</span>', add: '<span class="lg-pill in">↓ added</span>', remove: '<span class="lg-pill out">↑ removed</span>',
    send: e.amount < 0 ? '<span class="lg-pill mv">→ sent</span>' : '<span class="lg-pill mv">← in</span>', expense: '<span class="lg-pill out">↑ expense</span>',
    clear: '<span class="lg-pill mv">✔ cleared</span>' }[e.kind];
}
// Clear the Payment Gateway: its money was sent to the payment gateway (all of it, or the amount typed).
function lgOpenClear(){
  const bal = lgR2(lgBalances().gateway);
  openModal(`<div class="modal"><h2>✔ Clear the Payment Gateway</h2>
    <form onsubmit="return lgSaveClear(event)">
      <div class="lg-split">Payment Gateway balance now: <b>${lgPkr(bal)}</b><br>Saving takes the amount out of the Payment Gateway and the total balance, as <b>sent to the payment gateway</b>. It shows in the reports.</div>
      <div class="field-row" style="margin-top:12px;">
        <div class="field"><label>Amount sent (Rs)</label><input id="lgClAmt" type="number" step="0.01" min="0.01" max="${bal}" required value="${bal}"></div>
        <div class="field"><label>Sent on</label><input id="lgClDate" type="date" required value="${lgToday()}"></div>
      </div>
      <div class="field"><label>Note</label><input id="lgClNote" placeholder="optional, e.g. transaction ID"></div>
      <div class="modal-actions"><button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="width:auto;">✔ Clear</button></div>
    </form></div>`);
}
function lgSaveClear(e){
  e.preventDefault();
  lgSend('POST', '/ledger/moves', { type: 'send', from: 'gateway', to: 'outside', recipient: LG_CLEAR_TO, pkr: lgVal('lgClAmt'), date: lgVal('lgClDate'), note: lgVal('lgClNote') }, 'Payment Gateway cleared.');
  return false;
}
function lgPoolOptions(sel, withOutside){
  return Object.keys(LG_POOLS).map(k => `<option value="${k}" ${sel === k ? 'selected' : ''}>${LG_POOLS[k]}</option>`).join('')
    + (withOutside ? `<option value="outside" ${sel === 'outside' ? 'selected' : ''}>Someone outside (a person / bank)</option>` : '');
}
function lgOpenMove(type, id){
  const m = id ? lg.data.moves.find(x => x.id === id) : { type, date: lgToday(), pkr: '', from: 'gateway', to: 'account', note: '', recipient: '' };
  const title = { add: '↓ Add money', send: '→ Send money', remove: '↑ Remove money' }[m.type];
  openModal(`<div class="modal"><h2>${id ? 'Edit · ' : ''}${title}</h2>
    <form onsubmit="return lgSaveMove(event,'${m.type}',${id ? `'${id}'` : 'null'})">
      <div class="field-row">
        <div class="field"><label>Amount (Rs)</label><input id="lgMvPkr" type="number" step="0.01" min="0.01" required value="${m.pkr}"></div>
        <div class="field"><label>Date</label><input id="lgMvDate" type="date" required value="${m.date}"></div>
      </div>
      ${m.type !== 'add' ? `<div class="field"><label>From</label><select id="lgMvFrom">${lgPoolOptions(m.from)}</select></div>` : ''}
      ${m.type !== 'remove' ? `<div class="field"><label>To</label><select id="lgMvTo" onchange="document.getElementById('lgMvRecWrap') && (document.getElementById('lgMvRecWrap').style.display=this.value==='outside'?'':'none')">${lgPoolOptions(m.to, m.type === 'send')}</select></div>` : ''}
      ${m.type === 'send' ? `<div class="field" id="lgMvRecWrap" style="${m.to === 'outside' ? '' : 'display:none'}"><label>Sent to (name)</label><input id="lgMvRec" value="${escapeHtml(m.recipient)}" placeholder="e.g. enzra, bank account"></div>` : ''}
      <div class="field"><label>Note</label><input id="lgMvNote" value="${escapeHtml(m.note)}" placeholder="optional"></div>
      <div class="modal-actions">${id ? `<button type="button" class="btn btn-outline" onclick="lgDelete('/ledger/moves/${id}','entry')">Delete</button>` : ''}
        <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="width:auto;">Save</button></div>
    </form></div>`);
}
function lgSaveMove(e, type, id){
  e.preventDefault();
  const body = { type, date: lgVal('lgMvDate'), pkr: lgVal('lgMvPkr'), from: lgVal('lgMvFrom') || null, to: lgVal('lgMvTo') || null, recipient: lgVal('lgMvRec'), note: lgVal('lgMvNote') };
  lgSend(id ? 'PUT' : 'POST', '/ledger/moves' + (id ? '/' + id : ''), body, 'Saved.');
  return false;
}
function lgDelete(path, what){
  if(window.confirm(`Delete this ${what}? This can't be undone (the day's backup still has it).`)) lgSend('DELETE', path, undefined, 'Deleted.');
}

/* ---------------- Payouts ---------------- */
// X pays every 2 weeks (e.g. 6 Nov, 20 Nov): pick one payout day, see and add only its records.
const LG_DAY_CHIPS = 6; // newest payout days shown as buttons; older ones are in a list
function lgAllDays(){
  const all = lgPayDays();
  if(lg.newDay && !all.some(d => d.day === lg.newDay)) all.push({ day: lg.newDay, list: [], t: lgSum([]) });
  return all.sort((a, b) => a.day < b.day ? 1 : -1);
}
function lgSelDay(){
  const all = lgAllDays().map(d => d.day), want = state.ui.params.lgDay;
  return want && all.includes(want) ? want : (all[0] || null);
}
function lgPickDay(day){ state.ui.params.lgDay = day; render(); }
function lgPayouts(){
  const f = state.ui.params.lgFilter || 'all';
  const all = lgAllDays(), sel = lgSelDay(), d = all.find(x => x.day === sel);
  const chip = x => `<button class="lg-day ${x.day === sel ? 'on' : ''}" onclick="lgPickDay('${x.day}')"><b>${lgDate(x.day)}</b>
      <span>${x.t.n} member${x.t.n === 1 ? '' : 's'} · ${lgUsd(x.t.usd)}${x.t.waiting ? ` · <span class="wait">${x.t.waiting} waiting</span>` : ''}</span></button>`;
  const older = all.slice(LG_DAY_CHIPS);
  const days = `<div class="lg-days">${all.slice(0, LG_DAY_CHIPS).map(chip).join('')}
      ${older.length ? `<select class="select-sm" onchange="if(this.value) lgPickDay(this.value)"><option value="">Older payouts…</option>${older.map(x => `<option value="${x.day}" ${x.day === sel ? 'selected' : ''}>${lgDate(x.day)} · ${x.t.n} member${x.t.n === 1 ? '' : 's'} · ${lgUsd(x.t.usd)}</option>`).join('')}</select>` : ''}
      <button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgOpenNewDay()">+ New payout day</button></div>`;
  if(!d) return days + `<div class="card"><div class="empty">No payouts yet. Press <b>+ New payout day</b>, pick the day X paid (e.g. 6 Nov), then add each member's payout to it.</div></div>`;
  const rows = f === 'all' ? d.list : d.list.filter(p => p.status === f);
  return days + `<div class="card">
    <div class="lg-dayhead"><div><h3 style="margin:0;">💵 Payout of ${lgDate(d.day)}</h3>
      <div class="muted" style="font-size:12.5px;">${d.t.n} member${d.t.n === 1 ? '' : 's'} · ${lgUsd(d.t.usd)} X payouts · ${lgPkr(d.t.pkr)} received${d.t.waiting ? ` · ${d.t.waiting} waiting` : ''}</div></div>
      <div class="toolbar">
        <select class="select-sm" onchange="state.ui.params.lgFilter=this.value; render();">
          ${[['all', 'All'], ['pending', 'Waiting'], ['received', 'Received']].map(([k, l]) => `<option value="${k}" ${f === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgOpenPayout(null,'${d.day}')">+ Add member payout</button>
        ${d.list.length ? `<button class="btn btn-outline btn-sm" style="width:auto;" onclick="lgPrint('payday',{day:'${d.day}'})">📄 PDF report</button>` : ''}</div></div>
    ${rows.length ? `<div class="scrollx"><table class="to-cards"><thead><tr><th>Member</th><th>X payout</th><th>Status</th><th>Rate</th><th>Received</th><th>→ Gateway</th><th>→ Community</th><th></th></tr></thead><tbody>
    ${rows.map(p => { const s = lgPayoutSplit(p), su = lgSplitUsd(p.usd, p.rate); const rec = p.status === 'received'; return `<tr>
      <td data-label="Member"><b>${escapeHtml(lgMemberName(p))}</b>${p.note ? `<div class="muted" style="font-size:11.5px;">${escapeHtml(p.note)}</div>` : ''}</td>
      <td data-label="X payout">${lgUsd(p.usd)}</td>
      <td data-label="Status">${rec ? `<span class="lg-pill in">✔ Received</span><div class="muted" style="font-size:11.5px;">${lgDate(p.receivedDate)}</div>` : '<span class="lg-pill wait">⏳ Waiting</span>'}</td>
      <td data-label="Rate">${rec ? `${p.rate}% <span class="muted">(${lgUsd(p.usd * p.rate / 100)})</span>` : '—'}</td>
      <td data-label="Received">${rec ? lgPkr(p.receivedPkr) : '—'}</td>
      <td data-label="→ Gateway">${rec ? `${lgPkr(s.gateway)}${su.gateway ? `<div class="muted" style="font-size:11.5px;">${lgUsd(su.gateway)}</div>` : ''}` : '—'}</td>
      <td data-label="→ Community">${rec ? `${lgPkr(s.community)}${su.community ? `<div class="muted" style="font-size:11.5px;">${lgUsd(su.community)}</div>` : ''}` : '—'}</td>
      <td data-label="">${rec ? '' : `<button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgOpenReceive('${p.id}')">↓ Mark received</button>`}
        <button class="btn btn-outline btn-sm" onclick="${rec ? `lgOpenReceive('${p.id}')` : `lgOpenPayout('${p.id}')`}">Edit</button></td>
    </tr>`; }).join('')}
    </tbody></table></div>` : `<div class="empty">${d.list.length ? 'Nothing here with this filter.' : 'No members in this payout yet. Press <b>+ Add member payout</b>.'}</div>`}
  </div>`;
}
// Start the next payout day (X pays every 2 weeks, so 14 days after the last one is filled in).
function lgOpenNewDay(){
  const last = lgPayDays()[0], suggest = last ? lgAddDays(last.day, 14) : lgToday();
  openModal(`<div class="modal"><h2>+ New payout day</h2>
    <form onsubmit="return lgSaveNewDay(event)">
      <div class="field"><label>The day X paid</label><input id="lgNDay" type="date" required value="${suggest}"></div>
      <div class="muted" style="font-size:12px;">${last ? `X pays every 2 weeks; the last payout was ${lgDate(last.day)}, so ${lgDate(suggest)} is filled in. ` : ''}Next you add each member's payout to it.</div>
      <div class="modal-actions"><button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="width:auto;">Open this payout</button></div>
    </form></div>`);
}
function lgSaveNewDay(e){
  e.preventDefault();
  const day = lgVal('lgNDay');
  if(!day) return false;
  lg.newDay = day; state.ui.params.lgDay = day;
  closeModal(); render();
  lgOpenPayout(null, day); // straight on to the first member
  return false;
}
// Add a member to a payout day (only monetized members not in it yet), or edit one record.
function lgOpenPayout(id, day){
  const p = id ? lg.data.payouts.find(x => x.id === id) : null;
  day = p ? p.date : (day || lgSelDay() || lgToday());
  let members = [];
  if(!p){
    if(!lgMonetized().length){ toast('No monetized members yet. Tick "Monetized" on a member in the Members page first.', true); return; }
    const inDay = new Set(lg.data.payouts.filter(x => x.date === day).map(x => x.memberId));
    members = lg.data.members.filter(m => m.monetized && m.status === 'active' && !inDay.has(m.id)).sort((a, b) => a.name.localeCompare(b.name));
    if(!members.length){ toast(`Every monetized member is already in the ${lgDate(day)} payout.`, true); return; }
  }
  openModal(`<div class="modal"><h2>${p ? 'Edit payout' : `Add to the payout of ${lgDate(day)}`}</h2>
    <form onsubmit="return lgSavePayout(event,${p ? `'${id}'` : 'null'},'${day}')">
      ${p ? `<div class="field"><label>Member</label><div><b>${escapeHtml(lgMemberName(p))}</b></div></div>`
          : `<div class="field"><label>Member</label><select id="lgPMember">${members.map(m => `<option value="${m.id}">${escapeHtml(m.name)}${m.xUsername ? ' (@' + escapeHtml(m.xUsername) + ')' : ''}</option>`).join('')}</select>
             <div class="muted" style="font-size:11.5px;margin-top:4px;">${members.length} monetized member${members.length === 1 ? '' : 's'} not in this payout yet.</div></div>`}
      <div class="field-row">
        <div class="field"><label>X payout (USD)</label><input id="lgPUsd" type="number" step="0.01" min="0.01" required value="${p ? p.usd : ''}" placeholder="e.g. 115"></div>
        ${p ? `<div class="field"><label>Payout day</label><input id="lgPDate" type="date" required value="${p.date}"></div>` : ''}
      </div>
      <div class="field"><label>Note</label><input id="lgPNote" value="${p ? escapeHtml(p.note) : ''}" placeholder="optional"></div>
      ${p ? '' : `<div class="muted" style="font-size:12px;">It's saved as ⏳ Waiting. When the money comes in, press ↓ Mark received and enter the Rs.</div>`}
      <div class="modal-actions">${p ? `<button type="button" class="btn btn-outline" onclick="lgDelete('/ledger/payouts/${id}','payout')">Delete</button>` : ''}
        <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
        ${p || members.length < 2 ? '' : `<button class="btn btn-outline" style="width:auto;" onclick="lg.again=true">Save + add next</button>`}
        <button class="btn btn-primary" style="width:auto;">Save</button></div>
    </form></div>`);
}
function lgSavePayout(e, id, day){
  e.preventDefault();
  const again = lg.again; lg.again = false;
  const body = id ? { usd: lgVal('lgPUsd'), date: lgVal('lgPDate'), note: lgVal('lgPNote') }
                  : { memberId: lgVal('lgPMember'), usd: lgVal('lgPUsd'), date: day, note: lgVal('lgPNote') };
  lgSend(id ? 'PUT' : 'POST', '/ledger/payouts' + (id ? '/' + id : ''), body, id ? 'Payout saved.' : 'Added to the payout (waiting).').then(res => {
    if(!res) return;
    state.ui.params.lgDay = body.date; render(); // stay on (or move to) that payout day
    if(again) lgOpenPayout(null, body.date);
  });
  return false;
}
function lgRateRadios(name, sel){
  return `<div class="toolbar">${Object.keys(LG_RATES).sort((a, b) => b - a).map(p => `<label class="check-row" style="border:1.5px solid var(--line);border-radius:9px;padding:7px 12px;"><input type="radio" name="${name}" value="${p}" ${Number(sel) === Number(p) ? 'checked' : ''}> <b>${p}%</b></label>`).join('')}</div>`;
}
function lgOpenReceive(id){
  const p = lg.data.payouts.find(x => x.id === id);
  const m = lgMember(p.memberId) || {};
  const rate = p.rate || m.rate || 20;
  openModal(`<div class="modal"><h2>↓ Received · ${escapeHtml(lgMemberName(p))} · ${lgUsd(p.usd)}</h2>
    <form onsubmit="return lgSaveReceive(event,'${id}')">
      <div class="field-row">
        <div class="field"><label>Received (Rs)</label><input id="lgRPkr" type="number" step="0.01" min="0.01" required value="${p.receivedPkr || ''}" oninput="lgReceivePreview('${id}',true)" placeholder="e.g. 6530"></div>
        <div class="field"><label>Received on</label><input id="lgRDate" type="date" required value="${p.receivedDate || lgToday()}"></div>
      </div>
      <div class="field"><label>This is the member's</label><div onchange="lgReceivePreview('${id}',false)">${lgRateRadios('lgRRate', rate)}</div>
        <div class="muted" id="lgRGuess" style="font-size:12px;margin-top:6px;"></div></div>
      <div class="lg-split" id="lgRSplit"></div>
      <div class="modal-actions">${p.status === 'received' ? `<button type="button" class="btn btn-outline" onclick="if(confirm('Set this payout back to waiting?')) lgSend('POST','/ledger/payouts/${id}/unreceive',{}, 'Back to waiting.')">Undo received</button>` : ''}
        <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="width:auto;">✔ Save as received</button></div>
    </form></div>`);
  lgReceivePreview(id, false);
}
// Live preview; typing the amount auto-picks the rate from the USD rate in Settings.
function lgReceivePreview(id, autoPick){
  const p = lg.data.payouts.find(x => x.id === id);
  const amount = lgR2(lgVal('lgRPkr'));
  const guess = lgGuessRate(p.usd, amount);
  if(autoPick && guess){ const el = document.querySelector(`input[name="lgRRate"][value="${guess}"]`); if(el) el.checked = true; }
  const rate = Number((document.querySelector('input[name="lgRRate"]:checked') || {}).value);
  const s = lgSplit(amount, rate), su = lgSplitUsd(p.usd, rate);
  const implied = amount && rate ? amount / (p.usd * rate / 100) : null;
  document.getElementById('lgRGuess').innerHTML = guess ? `Auto-picked from 1 USD = Rs ${lg.data.settings.usdRate}: <b>${guess}%</b> looks right${guess !== rate ? ` (you picked ${rate}%)` : ''}.` : 'Set the USD rate in Ledger › Settings to auto-pick the %.';
  document.getElementById('lgRSplit').innerHTML = `
    ${escapeHtml(lgMemberName(p))}'s X payout <b>${lgUsd(p.usd)}</b> · ${rate}% = <b>${lgUsd(p.usd * rate / 100)}</b><br>
    Received <b>${lgPkr(amount)}</b>${implied ? ` <span class="muted">(≈ Rs ${lgR2(implied)} per $)</span>` : ''}<br>
    → Payment Gateway${su.gateway ? ` (${LG_RATES[rate].gateway}% = ${lgUsd(su.gateway)})` : ''} <b>${lgPkr(s.gateway)}</b><br>
    → Community Funds${su.community ? ` (${LG_RATES[rate].community}% = ${lgUsd(su.community)})` : ''} <b>${lgPkr(s.community)}</b>`;
}
function lgSaveReceive(e, id){
  e.preventDefault();
  const rate = Number((document.querySelector('input[name="lgRRate"]:checked') || {}).value);
  lgSend('POST', `/ledger/payouts/${id}/receive`, { receivedPkr: lgVal('lgRPkr'), rate, receivedDate: lgVal('lgRDate') }, 'Marked received and split.');
  return false;
}

/* ---------------- Members (from the site's member list) ---------------- */
function lgMembers(){
  const rows = lgMonetized();
  return `<div class="card">
      <div class="muted" style="font-size:12.5px;margin-bottom:12px;">Only <b>monetized</b> members are shown: tick "Monetized" on the site's Members page to add someone. "Usually gives" is picked when you mark their payout received (and it's remembered from the last payout); change it here any time.</div>
      ${rows.length ? `<div class="scrollx"><table class="to-cards"><thead><tr><th>Member</th><th>Usually gives</th><th>Payouts</th><th>X payouts</th><th>Received</th></tr></thead><tbody>
      ${rows.map(m => { const ps = lg.data.payouts.filter(p => p.memberId === m.id);
        return `<tr><td data-label="Member"><b>${escapeHtml(m.name)}</b> <span class="muted">${m.xUsername ? '@' + escapeHtml(m.xUsername) : ''}</span>${m.status !== 'active' ? ' <span class="badge inactive">inactive</span>' : ''}</td>
          <td data-label="Usually gives"><select class="select-sm" onchange="lgSend('PUT','/ledger/settings',{memberRates:{'${m.id}':this.value}}, 'Saved.')">${Object.keys(LG_RATES).sort((a, b) => b - a).map(r => `<option value="${r}" ${Number(m.rate) === Number(r) ? 'selected' : ''}>${r}%</option>`).join('')}</select></td>
          <td data-label="Payouts">${ps.length}</td><td data-label="X payouts">${lgUsd(ps.reduce((s, p) => s + p.usd, 0))}</td>
          <td data-label="Received">${lgPkr(ps.filter(p => p.status === 'received').reduce((s, p) => s + p.receivedPkr, 0))}</td></tr>`; }).join('')}
      </tbody></table></div>` : `<div class="empty">No monetized members yet.</div>`}
    </div>`;
}

/* ---------------- Expenses ---------------- */
function lgExpenses(){
  const rows = lg.data.expenses.slice().sort((a, b) => a.date < b.date ? 1 : -1);
  return `<div class="toolbar" style="margin-bottom:14px;"><button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgOpenExpense()">+ Add expense</button></div>
    <div class="muted" style="font-size:12.5px;margin-bottom:12px;">An expense is taken out of <b>Community Funds</b> (or the Payment Gateway if you pick it) straight away, and shows in that payout's PDF report and in the full summary.</div>
    <div class="grid-stats"><div class="stat-card"><div class="label">Total expenses</div><div class="value blue">${lgPkr(rows.reduce((s, e) => s + e.pkr, 0))}</div><div class="muted" style="font-size:12px;">${rows.length} expense${rows.length === 1 ? '' : 's'}</div></div></div>
    <div class="card">${rows.length ? `<div class="scrollx"><table class="to-cards"><thead><tr><th>Date</th><th>Category</th><th>Taken from</th><th>Note</th><th>Amount</th><th></th></tr></thead><tbody>
      ${rows.map(e => `<tr><td data-label="Date">${lgDate(e.date)}</td><td data-label="Category">${escapeHtml(e.category)}</td><td data-label="Taken from">${LG_POOLS[e.pool]}</td>
        <td data-label="Note" class="muted">${escapeHtml(e.note)}</td><td data-label="Amount"><b>${lgPkr(e.pkr)}</b></td>
        <td data-label=""><button class="btn btn-outline btn-sm" onclick="lgOpenExpense('${e.id}')">Edit</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">No expenses yet.</div>`}</div>`;
}
function lgOpenExpense(id){
  const e = id ? lg.data.expenses.find(x => x.id === id) : { date: lgToday(), pkr: '', pool: 'community', category: LG_EXPENSE_CATEGORIES[0], note: '' };
  openModal(`<div class="modal"><h2>${id ? 'Edit' : 'Add'} expense</h2>
    <form onsubmit="return lgSaveExpense(event,${id ? `'${id}'` : 'null'})">
      <div class="field-row">
        <div class="field"><label>Amount (Rs)</label><input id="lgEAmt" type="number" step="0.01" min="0.01" required value="${e.pkr}"></div>
        <div class="field"><label>Date</label><input id="lgEDate" type="date" required value="${e.date}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Category</label><select id="lgECat">${LG_EXPENSE_CATEGORIES.map(c => `<option ${e.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Taken from</label><select id="lgEPool">${['community', 'gateway'].concat(e.pool === 'account' ? ['account'] : []).map(k => `<option value="${k}" ${e.pool === k ? 'selected' : ''}>${LG_POOLS[k]}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Note</label><input id="lgENote" value="${escapeHtml(e.note)}" placeholder="what it was for"></div>
      <div class="modal-actions">${id ? `<button type="button" class="btn btn-outline" onclick="lgDelete('/ledger/expenses/${id}','expense')">Delete</button>` : ''}
        <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="width:auto;">Save</button></div>
    </form></div>`);
}
function lgSaveExpense(ev, id){
  ev.preventDefault();
  lgSend(id ? 'PUT' : 'POST', '/ledger/expenses' + (id ? '/' + id : ''), { pkr: lgVal('lgEAmt'), date: lgVal('lgEDate'), category: lgVal('lgECat'), pool: lgVal('lgEPool'), note: lgVal('lgENote') }, 'Expense saved.');
  return false;
}

/* ---------------- Reports (print -> Save as PDF) ----------------
   Two reports: one X payout day (X pays on set days, e.g. 6 Nov and 20 Nov) and the full summary.
   Expenses come out of their pool (Community Funds by default) and show in both. */
function lgAddDays(iso, n){ const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function lgSum(list){
  const t = { n: list.length, usd: 0, received: 0, pkr: 0, gateway: 0, community: 0, gatewayUsd: 0, communityUsd: 0, waiting: 0, waitingUsd: 0 };
  list.forEach(p => {
    t.usd += p.usd;
    if(p.status === 'received'){ const s = lgPayoutSplit(p), su = lgSplitUsd(p.usd, p.rate); t.received++; t.pkr += p.receivedPkr; t.gateway += s.gateway; t.community += s.community; t.gatewayUsd += su.gateway; t.communityUsd += su.community; }
    else { t.waiting++; t.waitingUsd += p.usd; }
  });
  return t;
}
// Every X payout day, newest first, with its payouts (A-Z) and totals.
function lgPayDays(){
  const by = {};
  lg.data.payouts.forEach(p => { (by[p.date] = by[p.date] || []).push(p); });
  return Object.keys(by).sort().reverse().map(day => ({ day, list: by[day].slice().sort((a, b) => lgMemberName(a).localeCompare(lgMemberName(b))), t: lgSum(by[day]) }));
}
// A payout day's report runs until the day before the next payout day (or up to now).
function lgDayPeriod(day){
  const next = lgPayDays().map(d => d.day).filter(d => d > day).sort()[0];
  return { from: day, to: next ? lgAddDays(next, -1) : null };
}
function lgPeriodText(from, to){ return `${from ? lgDate(from) : 'the start'} – ${to ? lgDate(to) : 'now'}`; }
// Money in each pool over a period: before it, what came in and went out, and after it.
function lgPoolFlow(from, to){
  const rows = {};
  Object.keys(LG_POOLS).forEach(k => { rows[k] = { before: 0, payouts: 0, added: 0, out: 0, expenses: 0, after: 0 }; });
  lgEntries().forEach(e => {
    const r = rows[e.pool];
    if(from && e.date < from){ r.before += e.amount; return; }
    if(to && e.date > to) return;
    if(e.kind === 'payout') r.payouts += e.amount;
    else if(e.kind === 'expense') r.expenses -= e.amount;
    else if(e.amount > 0) r.added += e.amount;
    else r.out -= e.amount;
  });
  Object.values(rows).forEach(r => { r.after = r.before + r.payouts + r.added - r.out - r.expenses; });
  return rows;
}

function lgReports(){
  const days = lgPayDays();
  const range = pfx => `<div class="field-row"><div class="field"><label>From</label><input id="${pfx}From" type="date"></div><div class="field"><label>To</label><input id="${pfx}To" type="date"></div></div>`;
  return `<div class="muted" style="font-size:12.5px;margin-bottom:12px;">Each PDF button opens the print window: pick <b>Save as PDF</b>. For a clean page, untick <b>Headers and footers</b> under More settings.</div>
    <div class="grid-stats" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));">
      <div class="card" style="margin:0;"><h3>💵 Payout report</h3>
        <div class="muted" style="font-size:12px;margin-bottom:10px;">One X payout day: every member paid that day, what came in, the Payment Gateway / Community Funds split, the expenses taken out until the next payout day, and each pool before and after.</div>
        ${days.length ? `<div class="field"><label>Payout day</label><select id="lgPdSel">${days.map(d => `<option value="${d.day}">${lgDate(d.day)} · ${d.t.n} member${d.t.n === 1 ? '' : 's'} · ${lgUsd(d.t.usd)}</option>`).join('')}</select></div>
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgPrint('payday',{day:lgVal('lgPdSel')})">📄 PDF</button>` : '<div class="muted">No payouts yet.</div>'}</div>
      <div class="card" style="margin:0;"><h3>📘 Full summary</h3>
        <div class="muted" style="font-size:12px;margin-bottom:10px;">Every payout day, the members who got a payout, expenses, board entries and the pools. Empty dates = everything.</div>
        ${range('lgFs')}<button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgPrint('summary',{from:lgVal('lgFsFrom'),to:lgVal('lgFsTo')})">📄 PDF</button></div>
    </div>`;
}

/* report building blocks (styled by #ledgerPrint in styles.css) */
function lgSm(t){ return t ? `<span class="sm">${t}</span>` : ''; }
function lgOrDash(v, txt){ return v ? txt : '<span class="dash">—</span>'; }
function lgDoc(title, sub, period, body){
  const name = escapeHtml(state.settings.communityName || 'Bitbase');
  return `<div class="lgp">
    <div class="lgp-top"><div class="lgp-brand"><div class="lgp-logo">${name.charAt(0).toUpperCase()}</div><div><div class="lgp-org">${name}</div><div class="lgp-tag">Ledger</div></div></div>
      <div class="lgp-title"><h1>${title}</h1><div>${sub}</div></div></div>
    <div class="lgp-meta"><span>Period: <b>${period}</b></span><span>Made ${lgDate(lgToday())}</span><span>$ = X payout · Rs = received in PKR</span></div>
    ${body}
    <div class="lgp-foot">${name} Ledger · ${title} · private, admins only</div></div>`;
}
function lgKpis(items){
  return `<div class="lgp-kpis">${items.map(([l, v, s, cls]) => `<div class="lgp-kpi ${cls || ''}"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`).join('')}</div>`;
}
function lgH2(t, note){ return `<h2><span>${t}</span>${note ? `<small>${note}</small>` : ''}</h2>`; }
function lgPaidTable(list){
  if(!list.length) return '<div class="lgp-empty">No payouts.</div>';
  const t = lgSum(list);
  return `<table><thead><tr><th class="c">#</th><th>Member</th><th class="n">X payout</th><th class="n">Gives</th><th class="n">Received</th><th class="n">Payment Gateway</th><th class="n">Community Funds</th></tr></thead><tbody>
    ${list.map((p, i) => { const m = lgMember(p.memberId) || {}, rec = p.status === 'received', s = lgPayoutSplit(p), su = lgSplitUsd(p.usd, p.rate);
      return `<tr><td class="c">${i + 1}</td><td><b>${escapeHtml(lgMemberName(p))}</b>${lgSm(m.xUsername ? '@' + escapeHtml(m.xUsername) : '')}</td>
        <td class="n">${lgUsd(p.usd)}</td>
        <td class="n">${rec ? `${p.rate}%${lgSm(lgUsd(p.usd * p.rate / 100))}` : '<span class="dash">—</span>'}</td>
        <td class="n">${rec ? `${lgPkr(p.receivedPkr)}${lgSm('on ' + lgDate(p.receivedDate))}` : '<span class="pill wait">Waiting</span>'}</td>
        <td class="n">${lgOrDash(s.gateway, `${lgPkr(s.gateway)}${lgSm(lgUsd(su.gateway))}`)}</td>
        <td class="n">${lgOrDash(s.community, `${lgPkr(s.community)}${lgSm(lgUsd(su.community))}`)}</td></tr>`; }).join('')}
    <tr class="tot"><td></td><td>Total · ${t.n} member${t.n === 1 ? '' : 's'}</td><td class="n">${lgUsd(t.usd)}</td><td></td><td class="n">${lgPkr(t.pkr)}</td>
      <td class="n">${lgPkr(t.gateway)}${lgSm(lgUsd(t.gatewayUsd))}</td><td class="n">${lgPkr(t.community)}${lgSm(lgUsd(t.communityUsd))}</td></tr></tbody></table>`;
}
function lgExpTable(list){
  if(!list.length) return '<div class="lgp-empty">No expenses in this period.</div>';
  return `<table><thead><tr><th>Date</th><th>What</th><th>Taken from</th><th class="n">Amount</th></tr></thead><tbody>
    ${list.map(e => `<tr><td>${lgDate(e.date)}</td><td><b>${escapeHtml(e.category)}</b>${lgSm(escapeHtml(e.note))}</td><td>${LG_POOLS[e.pool]}</td><td class="n neg">− ${lgPkr(e.pkr)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="3">Total expenses</td><td class="n neg">− ${lgPkr(list.reduce((s, e) => s + e.pkr, 0))}</td></tr></tbody></table>`;
}
function lgMoveTable(list){
  if(!list.length) return '';
  const what = m => lgIsClear(m) ? 'Payment Gateway cleared: sent to the payment gateway' : m.type === 'add' ? `Added to ${LG_POOLS[m.to]}` : m.type === 'remove' ? `Removed from ${LG_POOLS[m.from]}`
    : `${LG_POOLS[m.from]} → ${m.to === 'outside' ? escapeHtml(m.recipient || 'outside') : LG_POOLS[m.to]}`;
  return lgH2('Board entries') + `<table><thead><tr><th>Date</th><th>Entry</th><th>Note</th><th class="n">Amount</th></tr></thead><tbody>
    ${list.map(m => `<tr><td>${lgDate(m.date)}</td><td>${what(m)}</td><td>${escapeHtml(m.note) || '<span class="dash">—</span>'}</td><td class="n">${lgPkr(m.pkr)}</td></tr>`).join('')}</tbody></table>`;
}
function lgFlowTable(from, to){
  const f = lgPoolFlow(from, to), keys = Object.keys(LG_POOLS);
  const tot = { before: 0, payouts: 0, added: 0, out: 0, expenses: 0, after: 0 };
  keys.forEach(k => Object.keys(tot).forEach(c => { tot[c] += f[k][c]; }));
  const cell = (v, sign) => v ? `${sign}${lgPkr(v)}` : '<span class="dash">—</span>';
  const row = (label, r, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="n">${lgPkr(r.before)}</td><td class="n pos">${cell(r.payouts, '+ ')}</td><td class="n pos">${cell(r.added, '+ ')}</td>
    <td class="n neg">${cell(r.out, '− ')}</td><td class="n neg">${cell(r.expenses, '− ')}</td><td class="n"><b>${lgPkr(r.after)}</b></td></tr>`;
  return `<table><thead><tr><th>Pool</th><th class="n">Before${from ? ' ' + lgDate(from) : ''}</th><th class="n">From payouts</th><th class="n">Added / in</th><th class="n">Sent / removed</th><th class="n">Expenses</th><th class="n">After${to ? ' ' + lgDate(to) : ' (now)'}</th></tr></thead><tbody>
    ${keys.map(k => row(`<span class="dot ${k}"></span>${LG_POOLS[k]}`, f[k])).join('')}${row('Total', tot, 'tot')}</tbody></table>`;
}
function lgReportHtml(kind, o){
  const byDate = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  const d = lg.data;
  if(kind === 'payday'){
    const day = lgPayDays().find(x => x.day === o.day) || { day: o.day, list: [], t: lgSum([]) };
    const { from, to } = lgDayPeriod(o.day), t = day.t;
    const exps = d.expenses.filter(e => lgInRange(e.date, from, to)).sort(byDate);
    const moves = d.moves.filter(m => lgInRange(m.date, from, to)).sort(byDate);
    const expTotal = exps.reduce((s, e) => s + e.pkr, 0);
    return lgDoc('Payout report', `X payout of ${lgDate(o.day)}`, lgPeriodText(from, to),
      lgKpis([['Members paid', t.n], ['X payouts', lgUsd(t.usd)], ['Received', lgPkr(t.pkr), `${t.received} of ${t.n} payouts`], ['Waiting', t.waiting, t.waiting ? lgUsd(t.waitingUsd) + ' not in yet' : 'all received']]) +
      lgKpis([['→ Payment Gateway', lgPkr(t.gateway), lgUsd(t.gatewayUsd), 'gw'], ['→ Community Funds', lgPkr(t.community), lgUsd(t.communityUsd), 'cf'], ['Expenses', expTotal ? '− ' + lgPkr(expTotal) : lgPkr(0), `${exps.length} in this period`, 'ex']]) +
      lgH2(`Members paid on ${lgDate(o.day)}`, `${t.n} member${t.n === 1 ? '' : 's'}`) + lgPaidTable(day.list) +
      lgH2('Expenses', 'taken from Community Funds unless marked') + lgExpTable(exps) +
      lgMoveTable(moves) +
      lgH2('Money in each pool', lgPeriodText(from, to)) + lgFlowTable(from, to));
  }
  // Full summary (optionally between two dates).
  const from = o.from || '', to = o.to || '';
  const pays = d.payouts.filter(p => lgInRange(p.date, from, to));
  const days = lgPayDays().filter(x => lgInRange(x.day, from, to)).reverse();
  const exps = d.expenses.filter(e => lgInRange(e.date, from, to)).sort(byDate);
  const moves = d.moves.filter(m => lgInRange(m.date, from, to)).sort(byDate);
  const t = lgSum(pays), expTotal = exps.reduce((s, e) => s + e.pkr, 0);
  // Only members who actually got a payout in this period are listed.
  const byMember = {};
  pays.forEach(p => { (byMember[p.memberId] = byMember[p.memberId] || []).push(p); });
  const mRows = Object.values(byMember).map(list => ({ name: lgMemberName(list[0]), m: lgMember(list[0].memberId) || {}, t: lgSum(list) })).sort((a, b) => a.name.localeCompare(b.name));
  const sum = (rows, k) => rows.reduce((s, r) => s + r.t[k], 0);
  return lgDoc('Full summary', from || to ? lgPeriodText(from, to) : 'Everything so far', from || to ? lgPeriodText(from, to) : 'All dates',
    lgKpis([['Payout days', days.length], ['Members paid', mRows.length], ['X payouts', lgUsd(t.usd), `${t.n} payouts`], ['Received', lgPkr(t.pkr), `${t.received} of ${t.n} payouts`], ['Waiting', t.waiting, t.waiting ? lgUsd(t.waitingUsd) : 'all received']]) +
    lgKpis([['→ Payment Gateway', lgPkr(t.gateway), lgUsd(t.gatewayUsd), 'gw'], ['→ Community Funds', lgPkr(t.community), lgUsd(t.communityUsd), 'cf'], ['Expenses', expTotal ? '− ' + lgPkr(expTotal) : lgPkr(0), `${exps.length} expense${exps.length === 1 ? '' : 's'}`, 'ex']]) +
    lgH2('Payout days', `${days.length} X payout${days.length === 1 ? '' : 's'}`) +
    (days.length ? `<table><thead><tr><th>Payout day</th><th class="n">Members</th><th class="n">X payouts</th><th class="n">Received</th><th class="n">Payment Gateway</th><th class="n">Community Funds</th><th class="n">Waiting</th></tr></thead><tbody>
      ${days.map(x => `<tr><td><b>${lgDate(x.day)}</b></td><td class="n">${x.t.n}</td><td class="n">${lgUsd(x.t.usd)}</td><td class="n">${lgPkr(x.t.pkr)}</td><td class="n">${lgPkr(x.t.gateway)}${lgSm(lgUsd(x.t.gatewayUsd))}</td><td class="n">${lgPkr(x.t.community)}${lgSm(lgUsd(x.t.communityUsd))}</td><td class="n">${x.t.waiting ? `<span class="pill wait">${x.t.waiting} · ${lgUsd(x.t.waitingUsd)}</span>` : '<span class="pill ok">All in</span>'}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="n">${t.n}</td><td class="n">${lgUsd(t.usd)}</td><td class="n">${lgPkr(t.pkr)}</td><td class="n">${lgPkr(t.gateway)}</td><td class="n">${lgPkr(t.community)}</td><td class="n">${t.waiting ? lgUsd(t.waitingUsd) : ''}</td></tr></tbody></table>` : '<div class="lgp-empty">No payouts in this period.</div>') +
    lgH2(`Members who got a payout (${mRows.length})`) +
    (mRows.length ? `<table><thead><tr><th class="c">#</th><th>Member</th><th class="n">Payouts</th><th class="n">X payouts</th><th class="n">Received</th><th class="n">Payment Gateway</th><th class="n">Community Funds</th></tr></thead><tbody>
      ${mRows.map((r, i) => `<tr><td class="c">${i + 1}</td><td><b>${escapeHtml(r.name)}</b>${lgSm(r.m.xUsername ? '@' + escapeHtml(r.m.xUsername) : '')}</td><td class="n">${r.t.n}${r.t.waiting ? lgSm(r.t.waiting + ' waiting') : ''}</td><td class="n">${lgUsd(r.t.usd)}</td><td class="n">${lgOrDash(r.t.pkr, lgPkr(r.t.pkr))}</td><td class="n">${lgOrDash(r.t.gateway, lgPkr(r.t.gateway))}</td><td class="n">${lgOrDash(r.t.community, lgPkr(r.t.community))}</td></tr>`).join('')}
      <tr class="tot"><td></td><td>Total</td><td class="n">${sum(mRows, 'n')}</td><td class="n">${lgUsd(sum(mRows, 'usd'))}</td><td class="n">${lgPkr(sum(mRows, 'pkr'))}</td><td class="n">${lgPkr(sum(mRows, 'gateway'))}</td><td class="n">${lgPkr(sum(mRows, 'community'))}</td></tr></tbody></table>` : '<div class="lgp-empty">No payouts in this period.</div>') +
    lgH2('Expenses', 'taken from Community Funds unless marked') + lgExpTable(exps) +
    lgMoveTable(moves) +
    lgH2('Money in each pool', from || to ? lgPeriodText(from, to) : 'all dates') + lgFlowTable(from, to));
}
function lgPrint(kind, o){
  let box = document.getElementById('ledgerPrint');
  if(!box){ box = document.createElement('div'); box.id = 'ledgerPrint'; document.body.appendChild(box); }
  box.innerHTML = lgReportHtml(kind, o || {});
  const old = document.title, name = state.settings.communityName || 'Bitbase';
  document.title = kind === 'payday' ? `${name} payout report ${o.day}` : `${name} ledger summary ${lgToday()}`; // the default PDF file name
  document.body.classList.add('ledger-printing');
  const done = () => { document.body.classList.remove('ledger-printing'); document.title = old; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1500);
}

/* ---------------- Settings ---------------- */
function lgSettings(){
  const s = lg.data.settings;
  return `<div class="card" style="max-width:520px;"><h3>Ledger settings</h3>
      <form onsubmit="return lgSaveSettings(event)">
        <div class="field"><label>1 USD = how many Rs (only used to auto-pick 20% / 15% / 5%)</label><input id="lgSRate" type="number" step="0.01" min="0" value="${s.usdRate}"></div>
        <button class="btn btn-primary" style="width:auto;">Save</button></form></div>
    <div class="card" style="max-width:520px;"><h3>Change the ledger password</h3>
      <form onsubmit="return lgSetPassword(event,'change')">
        <div class="field"><label>Current ledger password</label><input id="lgCur" type="password" autocomplete="current-password" required></div>
        <div class="field-row"><div class="field"><label>New ledger password</label><input id="lgNew" type="password" autocomplete="new-password" minlength="6" required></div>
          <div class="field"><label>Type it again</label><input id="lgNew2" type="password" autocomplete="new-password" minlength="6" required></div></div>
        <button class="btn btn-primary" style="width:auto;">Change password</button></form></div>
    <div class="card" style="max-width:520px;"><h3>The fixed rules</h3>
      <div class="muted" style="font-size:12.5px;line-height:1.8;">A member gives 20%, 15% or 5% of their X payout. What you receive in Rs goes:<br>
      • <b>20%</b> → 15 parts Payment Gateway + 5 parts Community Funds (¾ and ¼); e.g. $115 → $23 = Rs 6,530 → Rs 4,897.50 + Rs 1,632.50<br>
      • <b>15%</b> → all to Payment Gateway &nbsp;• <b>5%</b> → all to Community Funds</div></div>
    <div class="card" style="max-width:520px;"><h3>Backups</h3>
      <div class="muted" style="font-size:12.5px;margin-bottom:10px;">Everything is saved on the server. Every change also keeps that day's full copy on the server (90 days). Download a copy to keep one yourself too. Restore also accepts a backup from the sandbox (members are matched by X username or name).</div>
      <div class="toolbar">
        <button class="btn btn-outline btn-sm" style="width:auto;" onclick="lgDownloadBackup()">⬇ Download backup</button>
        <label class="btn btn-outline btn-sm" style="width:auto;cursor:pointer;">⬆ Restore a backup<input type="file" accept=".json,application/json" style="display:none" onchange="lgRestoreFile(event)"></label>
      </div></div>
    <div class="card" style="max-width:520px;border:1.5px solid var(--danger-bg);"><h3>🧹 Clear all ledger data</h3>
      <div class="muted" style="font-size:12.5px;margin-bottom:10px;">Deletes every payout, expense and board entry so the Ledger starts empty
        (now: ${lg.data.payouts.length} payouts, ${lg.data.expenses.length} expenses, ${lg.data.moves.length} board entries).
        The ledger password, USD rate and members' usual % stay. A backup file downloads to this PC first and the server keeps a copy too,
        so it can be brought back with <b>⬆ Restore a backup</b>.</div>
      <form onsubmit="return lgClearAll(event)">
        <div class="field-row">
          <div class="field"><label>Ledger password</label><input id="lgClrPw" type="password" autocomplete="current-password" required></div>
          <div class="field"><label>Type CLEAR to confirm</label><input id="lgClrTxt" autocomplete="off" required placeholder="CLEAR"></div>
        </div>
        <button class="btn btn-danger btn-sm" style="width:auto;">🧹 Clear all ledger data</button></form></div>`;
}
function lgSaveSettings(e){ e.preventDefault(); lgSend('PUT', '/ledger/settings', { usdRate: lgVal('lgSRate') }, 'Settings saved.'); return false; }
// Downloads a backup file of the whole ledger; true when it worked.
async function lgDownloadBackup(){
  try{
    const b = await apiGet('/ledger/backup');
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `bitbase-ledger-backup-${lgToday()}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return true;
  }catch(err){ toast(err.message, true); return false; }
}
// Clear all ledger data: download a backup first, then clear (the server also keeps a copy).
function lgClearAll(e){
  e.preventDefault();
  const pw = lgVal('lgClrPw'), d = lg.data;
  if(lgVal('lgClrTxt').trim().toUpperCase() !== 'CLEAR'){ toast('Type CLEAR to confirm.', true); return false; }
  if(!(d.payouts.length + d.expenses.length + d.moves.length)){ toast('The Ledger is already empty.'); return false; }
  if(!window.confirm(`Clear ${d.payouts.length} payouts, ${d.expenses.length} expenses and ${d.moves.length} board entries? A backup file downloads first.`)) return false;
  (async () => {
    if(!(await lgDownloadBackup())){ toast('The backup could not be downloaded, so nothing was cleared.', true); return; }
    const res = await lgSend('POST', '/ledger/clear', { password: pw }, 'Ledger cleared. The backup file is in your Downloads.');
    if(res){ lg.newDay = null; delete state.ui.params.lgDay; render(); }
  })();
  return false;
}
function lgRestoreFile(ev){
  const f = ev.target.files[0]; if(!f) return;
  const rd = new FileReader();
  rd.onload = async () => {
    let backup;
    try{ backup = JSON.parse(rd.result); }catch(e){ toast('That file is not a ledger backup.', true); return; }
    try{
      const { preview } = await apiSend('POST', '/ledger/restore', { backup, confirm: false });
      lg.pendingRestore = backup;
      openModal(`<div class="modal"><h2>Restore this backup?</h2>
        <div class="lg-split">${preview.payouts} payouts · ${preview.expenses} expenses · ${preview.moves} board entries</div>
        ${preview.skipped.length ? `<div class="muted" style="font-size:12.5px;margin-top:10px;">Not on the site's member list, so their payouts are skipped: <b>${preview.skipped.map(escapeHtml).join(', ')}</b>. Add them on the Members page first to keep those.</div>` : ''}
        <div class="muted" style="font-size:12.5px;margin-top:10px;">This <b>replaces</b> the ledger. The current ledger is saved on the server first, so it can be brought back.</div>
        <div class="modal-actions"><button class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" style="width:auto;" onclick="lgSend('POST','/ledger/restore',{backup:lg.pendingRestore,confirm:true}, 'Backup restored.')">Replace the ledger</button></div></div>`);
    }catch(err){ toast(err.message, true); }
  };
  rd.readAsText(f);
}
