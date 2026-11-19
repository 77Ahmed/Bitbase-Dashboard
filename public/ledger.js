/* ===================== Bitbase Ledger (admin page) =====================
   Admin-only page behind its own LEDGER password (see ledger-server.js).
   Members' X payouts in USD; money received in PKR, split by the member's fixed rate:
     20% -> 15 parts Payment Gateway + 5 parts Community Funds   15% -> all Gateway   5% -> all Community
   Pools: Payment Gateway, Account, Community Funds. Expenses + board entries (add / send /
   remove) move money between them. Reports open the print window (Save as PDF).
   Everything is stored on the server; this file only shows it and sends changes.
   All names here start with lg so they never clash with app.js. */
'use strict';

const LG_POOLS = { gateway: 'Payment Gateway', account: 'Account', community: 'Community Funds' };
const LG_RATES = { 20: { gateway: 15, community: 5 }, 15: { gateway: 15 }, 5: { community: 5 } };
const LG_EXPENSE_CATEGORIES = ['Bank / transfer fee', 'Tools & software', 'Promotion', 'Prizes & rewards', 'Salary / help', 'Other'];
const LG_TABS = [['board', 'Board'], ['payouts', 'Payouts'], ['members', 'Members'], ['expenses', 'Expenses'], ['reports', 'Reports (PDF)'], ['settings', 'Settings']];

// status: null (not asked yet) | { unlocked, hasPassword };  data: what GET /api/ledger returned
var lg = { status: null, data: null, loading: false, lockForm: 'unlock' };

/* ---------------- helpers ---------------- */
function lgR2(n){ return Math.round((Number(n) || 0) * 100) / 100; }
function lgPkr(n){ return 'Rs ' + lgR2(n).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function lgUsd(n){ return '$' + lgR2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function lgDate(iso){ return iso ? fmtDate(iso) : '—'; }
function lgToday(){ return calendarToday(); }
function lgMonthOf(iso){ return (iso || '').slice(0, 7); }
function lgMonthLabel(ym){ const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }
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
    if(m.type === 'add') out.push({ date: m.date, pool: m.to, amount: m.pkr, kind: 'add', text: m.note || 'Added' });
    if(m.type === 'remove') out.push({ date: m.date, pool: m.from, amount: -m.pkr, kind: 'remove', text: m.note || 'Removed' });
    if(m.type === 'send'){
      out.push({ date: m.date, pool: m.from, amount: -m.pkr, kind: 'send', text: (m.to === 'outside' ? `Sent to ${m.recipient || 'outside'}` : `Sent to ${LG_POOLS[m.to]}`) + (m.note ? ' · ' + m.note : '') });
      if(m.to !== 'outside') out.push({ date: m.date, pool: m.to, amount: m.pkr, kind: 'send', text: `From ${LG_POOLS[m.from]}` + (m.note ? ' · ' + m.note : '') });
    }
  });
  d.expenses.forEach(e => out.push({ date: e.date, pool: e.pool, amount: -e.pkr, kind: 'expense', text: `${e.category}${e.note ? ' · ' + e.note : ''}` }));
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
  return `
    <div class="toolbar" style="margin-bottom:14px;">
      <button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgOpenMove('add')">↓ Add money</button>
      <button class="btn btn-outline btn-sm" style="width:auto;" onclick="lgOpenMove('send')">→ Send</button>
      <button class="btn btn-outline btn-sm" style="width:auto;" onclick="lgOpenMove('remove')">↑ Remove</button>
      <button class="btn btn-outline btn-sm" style="width:auto;" onclick="lgOpenExpense()">+ Expense</button>
    </div>
    <div class="grid-stats">
      <div class="stat-card"><div class="label">Total balance</div><div class="value blue">${lgPkr(b.gateway + b.account + b.community)}</div></div>
      ${Object.keys(LG_POOLS).map(k => `<div class="stat-card"><div class="label">${LG_POOLS[k]}</div><div class="value blue">${lgPkr(b[k])}</div></div>`).join('')}
    </div>
    <div class="grid-stats">
      <div class="stat-card"><div class="label">Payouts recorded</div><div class="value">${t.payouts}</div><div class="muted" style="font-size:12px;">${lgUsd(t.payoutUsd)} in X payouts</div></div>
      <div class="stat-card"><div class="label">Received</div><div class="value">${lgPkr(t.receivedPkr)}</div><div class="muted" style="font-size:12px;">${t.received} payout${t.received === 1 ? '' : 's'}</div></div>
      <div class="stat-card"><div class="label">Waiting</div><div class="value">${t.pending}</div><div class="muted" style="font-size:12px;">${lgUsd(t.pendingUsd)} not received yet</div></div>
      <div class="stat-card"><div class="label">Expenses</div><div class="value">${lgPkr(t.expensesPkr)}</div><div class="muted" style="font-size:12px;">${t.expenses} expense${t.expenses === 1 ? '' : 's'}</div></div>
    </div>
    <div class="card"><h3>Latest money movements</h3>
      ${entries.length ? `<div class="scrollx"><table class="to-cards"><thead><tr><th>Date</th><th>What</th><th>Pool</th><th>Amount</th></tr></thead><tbody>
        ${entries.map(e => `<tr><td data-label="Date">${lgDate(e.date)}</td><td data-label="What">${lgKindPill(e)} ${escapeHtml(e.text)}</td><td data-label="Pool">${LG_POOLS[e.pool]}</td>
          <td data-label="Amount" style="font-weight:700;color:${e.amount < 0 ? 'var(--danger)' : 'var(--success)'}">${e.amount < 0 ? '−' : '+'}${lgPkr(Math.abs(e.amount))}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">Nothing yet. Add a payout in the Payouts tab.</div>`}
    </div>`;
}
function lgKindPill(e){
  return { payout: '<span class="lg-pill in">↓ received</span>', add: '<span class="lg-pill in">↓ added</span>', remove: '<span class="lg-pill out">↑ removed</span>',
    send: e.amount < 0 ? '<span class="lg-pill mv">→ sent</span>' : '<span class="lg-pill mv">← in</span>', expense: '<span class="lg-pill out">↑ expense</span>' }[e.kind];
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
function lgPayouts(){
  const f = state.ui.params.lgFilter || 'all';
  let rows = lg.data.payouts.slice().sort((a, b) => a.date < b.date ? 1 : -1);
  if(f !== 'all') rows = rows.filter(p => p.status === f);
  return `<div class="toolbar" style="margin-bottom:14px;">
      <select class="select-sm" onchange="state.ui.params.lgFilter=this.value; render();">
        ${[['all', 'All'], ['pending', 'Waiting'], ['received', 'Received']].map(([k, l]) => `<option value="${k}" ${f === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgOpenPayout()">+ Add payout</button></div>
    <div class="card">${rows.length ? `<div class="scrollx"><table class="to-cards"><thead><tr><th>Payout day</th><th>Member</th><th>X payout</th><th>Status</th><th>Rate</th><th>Received</th><th>→ Gateway</th><th>→ Community</th><th></th></tr></thead><tbody>
      ${rows.map(p => { const s = lgPayoutSplit(p), su = lgSplitUsd(p.usd, p.rate); const rec = p.status === 'received'; return `<tr>
        <td data-label="Payout day">${lgDate(p.date)}</td>
        <td data-label="Member"><b>${escapeHtml(lgMemberName(p))}</b>${p.note ? `<div class="muted" style="font-size:11.5px;">${escapeHtml(p.note)}</div>` : ''}</td>
        <td data-label="X payout">${lgUsd(p.usd)}</td>
        <td data-label="Status">${rec ? `<span class="lg-pill in">✔ Received</span><div class="muted" style="font-size:11.5px;">${lgDate(p.receivedDate)}</div>` : '<span class="lg-pill wait">⏳ Waiting</span>'}</td>
        <td data-label="Rate">${rec ? `${p.rate}% <span class="muted">(${lgUsd(p.usd * p.rate / 100)})</span>` : '—'}</td>
        <td data-label="Received">${rec ? lgPkr(p.receivedPkr) : '—'}</td>
        <td data-label="→ Gateway">${rec ? `${lgPkr(s.gateway)}${su.gateway ? `<div class="muted" style="font-size:11.5px;">${lgUsd(su.gateway)}</div>` : ''}` : '—'}</td>
        <td data-label="→ Community">${rec ? `${lgPkr(s.community)}${su.community ? `<div class="muted" style="font-size:11.5px;">${lgUsd(su.community)}</div>` : ''}` : '—'}</td>
        <td data-label="">${rec ? '' : `<button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgOpenReceive('${p.id}')">↓ Mark received</button>`}
          <button class="btn btn-outline btn-sm" onclick="${rec ? `lgOpenReceive('${p.id}')` : `lgOpenPayout('${p.id}')`}">Edit</button>
          <button class="btn btn-outline btn-sm" onclick="lgPrint('payout',{id:'${p.id}'})">PDF</button></td>
      </tr>`; }).join('')}
      </tbody></table></div>` : `<div class="empty">No payouts here yet.</div>`}</div>`;
}
function lgOpenPayout(id){
  const members = lg.data.members.filter(m => (m.monetized && m.status === 'active') || (id && lg.data.payouts.find(p => p.id === id).memberId === m.id));
  if(!members.length){ toast('No monetized members yet. Tick "Monetized" on a member in the Members page first.', true); return; }
  const p = id ? lg.data.payouts.find(x => x.id === id) : { memberId: members[0].id, date: lgToday(), usd: '', note: '' };
  openModal(`<div class="modal"><h2>${id ? 'Edit' : 'Add'} payout</h2>
    <form onsubmit="return lgSavePayout(event,${id ? `'${id}'` : 'null'})">
      <div class="field"><label>Member</label><select id="lgPMember" ${id ? 'disabled' : ''}>${members.map(m => `<option value="${m.id}" ${p.memberId === m.id ? 'selected' : ''}>${escapeHtml(m.name)}${m.xUsername ? ' (@' + escapeHtml(m.xUsername) + ')' : ''}</option>`).join('')}</select></div>
      <div class="field-row">
        <div class="field"><label>X payout (USD)</label><input id="lgPUsd" type="number" step="0.01" min="0.01" required value="${p.usd}" placeholder="e.g. 115"></div>
        <div class="field"><label>Payout day</label><input id="lgPDate" type="date" required value="${p.date}"></div>
      </div>
      <div class="field"><label>Note</label><input id="lgPNote" value="${escapeHtml(p.note)}" placeholder="optional"></div>
      <div class="muted" style="font-size:12px;">It's saved as ⏳ Waiting. When the money comes in, press ↓ Mark received and enter the Rs.</div>
      <div class="modal-actions">${id ? `<button type="button" class="btn btn-outline" onclick="lgDelete('/ledger/payouts/${id}','payout')">Delete</button>` : ''}
        <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="width:auto;">Save</button></div>
    </form></div>`);
}
function lgSavePayout(e, id){
  e.preventDefault();
  lgSend(id ? 'PUT' : 'POST', '/ledger/payouts' + (id ? '/' + id : ''), { memberId: lgVal('lgPMember'), usd: lgVal('lgPUsd'), date: lgVal('lgPDate'), note: lgVal('lgPNote') }, 'Payout saved (waiting).');
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
  return `<div class="toolbar" style="margin-bottom:14px;"><button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgOpenExpense()">+ Add expense</button>
      <button class="btn btn-outline btn-sm" style="width:auto;" onclick="lgPrint('expenses',{})">PDF</button></div>
    <div class="grid-stats"><div class="stat-card"><div class="label">Total expenses</div><div class="value blue">${lgPkr(rows.reduce((s, e) => s + e.pkr, 0))}</div><div class="muted" style="font-size:12px;">${rows.length} expense${rows.length === 1 ? '' : 's'}</div></div></div>
    <div class="card">${rows.length ? `<div class="scrollx"><table class="to-cards"><thead><tr><th>Date</th><th>Category</th><th>Paid from</th><th>Note</th><th>Amount</th><th></th></tr></thead><tbody>
      ${rows.map(e => `<tr><td data-label="Date">${lgDate(e.date)}</td><td data-label="Category">${escapeHtml(e.category)}</td><td data-label="Paid from">${LG_POOLS[e.pool]}</td>
        <td data-label="Note" class="muted">${escapeHtml(e.note)}</td><td data-label="Amount"><b>${lgPkr(e.pkr)}</b></td>
        <td data-label=""><button class="btn btn-outline btn-sm" onclick="lgOpenExpense('${e.id}')">Edit</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">No expenses yet.</div>`}</div>`;
}
function lgOpenExpense(id){
  const e = id ? lg.data.expenses.find(x => x.id === id) : { date: lgToday(), pkr: '', pool: 'account', category: LG_EXPENSE_CATEGORIES[0], note: '' };
  openModal(`<div class="modal"><h2>${id ? 'Edit' : 'Add'} expense</h2>
    <form onsubmit="return lgSaveExpense(event,${id ? `'${id}'` : 'null'})">
      <div class="field-row">
        <div class="field"><label>Amount (Rs)</label><input id="lgEAmt" type="number" step="0.01" min="0.01" required value="${e.pkr}"></div>
        <div class="field"><label>Date</label><input id="lgEDate" type="date" required value="${e.date}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Category</label><select id="lgECat">${LG_EXPENSE_CATEGORIES.map(c => `<option ${e.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Paid from</label><select id="lgEPool">${lgPoolOptions(e.pool)}</select></div>
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

/* ---------------- Reports (print -> Save as PDF) ---------------- */
function lgMonths(){
  const s = new Set([lgMonthOf(lgToday())]);
  lg.data.payouts.forEach(p => { s.add(lgMonthOf(p.date)); if(p.receivedDate) s.add(lgMonthOf(p.receivedDate)); });
  lg.data.expenses.forEach(e => s.add(lgMonthOf(e.date))); lg.data.moves.forEach(m => s.add(lgMonthOf(m.date)));
  return [...s].filter(Boolean).sort().reverse();
}
function lgReports(){
  const range = pfx => `<div class="field-row"><div class="field"><label>From</label><input id="${pfx}From" type="date"></div><div class="field"><label>To</label><input id="${pfx}To" type="date"></div></div>`;
  // Monetized members, plus anyone who already has a payout (so old statements can still be printed).
  const members = lg.data.members.filter(m => m.monetized || lg.data.payouts.some(p => p.memberId === m.id));
  return `<div class="muted" style="font-size:12.5px;margin-bottom:12px;">Each button opens the print window: choose <b>Save as PDF</b> as the printer. Empty dates = everything.</div>
    <div class="grid-stats" style="grid-template-columns:repeat(auto-fit,minmax(250px,1fr));">
      <div class="card" style="margin:0;"><h3>📘 Full summary</h3><div class="muted" style="font-size:12px;margin-bottom:10px;">Members who got a payout, money received, what went to the Payment Gateway and Community Funds, expenses and balances.</div>
        ${range('lgFs')}<button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgPrint('summary',{from:lgVal('lgFsFrom'),to:lgVal('lgFsTo')})">PDF</button></div>
      <div class="card" style="margin:0;"><h3>📅 Monthly</h3><div class="field"><label>Month</label><select id="lgMoSel">${lgMonths().map(m => `<option value="${m}">${lgMonthLabel(m)}</option>`).join('')}</select></div>
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgPrint('month',{month:lgVal('lgMoSel')})">PDF</button></div>
      <div class="card" style="margin:0;"><h3>👤 Per member</h3>${members.length ? `<div class="field"><label>Member</label><select id="lgPmSel">${members.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}</select></div>${range('lgPm')}
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgPrint('member',{id:lgVal('lgPmSel'),from:lgVal('lgPmFrom'),to:lgVal('lgPmTo')})">PDF</button>` : '<div class="muted">No members yet.</div>'}</div>
      <div class="card" style="margin:0;"><h3>🧾 Expenses</h3>${range('lgEx')}<button class="btn btn-primary btn-sm" style="width:auto;" onclick="lgPrint('expenses',{from:lgVal('lgExFrom'),to:lgVal('lgExTo')})">PDF</button></div>
      <div class="card" style="margin:0;"><h3>💵 One payout</h3><div class="muted" style="font-size:12px;">Use the <b>PDF</b> button on a row in Payouts.</div></div>
    </div>`;
}
function lgRangeText(from, to){ return from || to ? `${from ? lgDate(from) : 'start'} to ${to ? lgDate(to) : 'today'}` : 'All dates'; }
function lgBox(l, v){ return `<div class="lgp-box"><div class="l">${l}</div><div class="v">${v}</div></div>`; }
function lgHeader(title, sub){ return `<h1>${escapeHtml(state.settings.communityName || 'Bitbase')} · ${title}</h1><div class="lgp-meta">${sub} · made ${lgDate(lgToday())}</div>`; }
function lgPayoutTable(list){
  if(!list.length) return '<div class="lgp-meta">No payouts.</div>';
  const tot = { usd: 0, pkr: 0, gw: 0, cf: 0 };
  return `<table><thead><tr><th>Payout day</th><th>Member</th><th>X payout</th><th>Status</th><th>Rate</th><th>Received</th><th>Payment Gateway</th><th>Community Funds</th></tr></thead><tbody>
    ${list.map(p => { const s = lgPayoutSplit(p), su = lgSplitUsd(p.usd, p.rate); tot.usd += p.usd; tot.pkr += p.receivedPkr || 0; tot.gw += s.gateway; tot.cf += s.community;
      const rec = p.status === 'received';
      return `<tr><td>${lgDate(p.date)}</td><td>${escapeHtml(lgMemberName(p))}</td><td class="n">${lgUsd(p.usd)}</td><td>${rec ? 'Received ' + lgDate(p.receivedDate) : 'Waiting'}</td>
        <td>${rec ? p.rate + '%' : '—'}</td><td class="n">${rec ? lgPkr(p.receivedPkr) : '—'}</td>
        <td class="n">${lgPkr(s.gateway)}${rec && su.gateway ? ` (${lgUsd(su.gateway)})` : ''}</td><td class="n">${lgPkr(s.community)}${rec && su.community ? ` (${lgUsd(su.community)})` : ''}</td></tr>`; }).join('')}
    <tr class="tot"><td colspan="2">Total</td><td class="n">${lgUsd(tot.usd)}</td><td></td><td></td><td class="n">${lgPkr(tot.pkr)}</td><td class="n">${lgPkr(tot.gw)}</td><td class="n">${lgPkr(tot.cf)}</td></tr></tbody></table>`;
}
function lgExpenseTable(list){
  if(!list.length) return '<div class="lgp-meta">No expenses.</div>';
  return `<table><thead><tr><th>Date</th><th>Category</th><th>Paid from</th><th>Note</th><th>Amount</th></tr></thead><tbody>
    ${list.map(e => `<tr><td>${lgDate(e.date)}</td><td>${escapeHtml(e.category)}</td><td>${LG_POOLS[e.pool]}</td><td>${escapeHtml(e.note)}</td><td class="n">${lgPkr(e.pkr)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="4">Total</td><td class="n">${lgPkr(list.reduce((s, e) => s + e.pkr, 0))}</td></tr></tbody></table>`;
}
function lgMovesTable(list){
  if(!list.length) return '';
  return `<h2>Board entries (add / send / remove)</h2><table><thead><tr><th>Date</th><th>Type</th><th>From</th><th>To</th><th>Note</th><th>Amount</th></tr></thead><tbody>
    ${list.map(m => `<tr><td>${lgDate(m.date)}</td><td>${m.type}</td><td>${m.from ? LG_POOLS[m.from] : '—'}</td><td>${m.to ? (m.to === 'outside' ? escapeHtml(m.recipient || 'outside') : LG_POOLS[m.to]) : '—'}</td><td>${escapeHtml(m.note)}</td><td class="n">${lgPkr(m.pkr)}</td></tr>`).join('')}</tbody></table>`;
}
function lgReportHtml(kind, o){
  const byDate = (a, b) => a.date < b.date ? -1 : 1;
  const d = lg.data;
  if(kind === 'payout'){
    const p = d.payouts.find(x => x.id === o.id), s = lgPayoutSplit(p), su = lgSplitUsd(p.usd, p.rate), m = lgMember(p.memberId) || {};
    const rec = p.status === 'received';
    return lgHeader('Payout', `${escapeHtml(lgMemberName(p))}${m.xUsername ? ' (@' + escapeHtml(m.xUsername) + ')' : ''} · payout day ${lgDate(p.date)}`) +
      `<table><tbody><tr><th>Member</th><td>${escapeHtml(lgMemberName(p))}</td></tr><tr><th>X payout</th><td>${lgUsd(p.usd)}</td></tr>
        <tr><th>Status</th><td>${rec ? 'Received on ' + lgDate(p.receivedDate) : 'Waiting'}</td></tr>
        ${rec ? `<tr><th>Rate</th><td>${p.rate}% = ${lgUsd(p.usd * p.rate / 100)}</td></tr>
        <tr><th>Received</th><td>${lgPkr(p.receivedPkr)} (≈ Rs ${lgR2(p.receivedPkr / (p.usd * p.rate / 100))} per $)</td></tr>
        <tr><th>→ Payment Gateway</th><td>${lgPkr(s.gateway)}${su.gateway ? ` (${lgUsd(su.gateway)})` : ''}</td></tr>
        <tr><th>→ Community Funds</th><td>${lgPkr(s.community)}${su.community ? ` (${lgUsd(su.community)})` : ''}</td></tr>` : ''}
        ${p.note ? `<tr><th>Note</th><td>${escapeHtml(p.note)}</td></tr>` : ''}</tbody></table>`;
  }
  if(kind === 'member'){
    const m = lgMember(o.id) || {};
    const list = d.payouts.filter(p => p.memberId === o.id && lgInRange(p.date, o.from, o.to)).sort(byDate);
    const rec = list.filter(p => p.status === 'received');
    return lgHeader('Member statement', `${escapeHtml(m.name || '')}${m.xUsername ? ' (@' + escapeHtml(m.xUsername) + ')' : ''} · ${lgRangeText(o.from, o.to)}`) +
      `<div class="lgp-boxes">${lgBox('Payouts', list.length)}${lgBox('X payouts', lgUsd(list.reduce((s, p) => s + p.usd, 0)))}${lgBox('Received', lgPkr(rec.reduce((s, p) => s + p.receivedPkr, 0)))}${lgBox('Waiting', list.length - rec.length)}</div>
      <h2>Payouts</h2>${lgPayoutTable(list)}`;
  }
  if(kind === 'expenses'){
    const list = d.expenses.filter(e => lgInRange(e.date, o.from, o.to)).sort(byDate);
    const byCat = {}; list.forEach(e => byCat[e.category] = (byCat[e.category] || 0) + e.pkr);
    return lgHeader('Expenses', lgRangeText(o.from, o.to)) +
      `<div class="lgp-boxes">${lgBox('Total', lgPkr(list.reduce((s, e) => s + e.pkr, 0)))}${lgBox('Expenses', list.length)}</div>
      ${Object.keys(byCat).length ? `<h2>By category</h2><table><thead><tr><th>Category</th><th>Amount</th></tr></thead><tbody>${Object.keys(byCat).sort().map(c => `<tr><td>${escapeHtml(c)}</td><td class="n">${lgPkr(byCat[c])}</td></tr>`).join('')}</tbody></table>` : ''}
      <h2>All expenses</h2>${lgExpenseTable(list)}`;
  }
  let from = o.from, to = o.to, title = 'Full summary', sub = lgRangeText(o.from, o.to);
  if(kind === 'month'){ from = o.month + '-01'; to = o.month + '-31'; title = 'Monthly report'; sub = lgMonthLabel(o.month); }
  const t = lgTotals(from, to);
  const pays = d.payouts.filter(p => lgInRange(p.date, from, to)).sort(byDate);
  const exps = d.expenses.filter(e => lgInRange(e.date, from, to)).sort(byDate);
  const moves = d.moves.filter(m => lgInRange(m.date, from, to)).sort(byDate);
  const b = lgBalances(to);
  // Only members who actually got a payout in this period are listed.
  const byMember = {};
  pays.forEach(p => { const k = p.memberId; byMember[k] = byMember[k] || { name: lgMemberName(p), n: 0, usd: 0, pkr: 0, rec: 0 }; byMember[k].n++; byMember[k].usd += p.usd; if(p.status === 'received'){ byMember[k].rec++; byMember[k].pkr += p.receivedPkr; } });
  const mRows = Object.values(byMember).sort((a, b2) => a.name.localeCompare(b2.name));
  return lgHeader(title, sub) +
    `<div class="lgp-boxes">${lgBox('Members paid', t.members.size)}${lgBox('Payouts', t.payouts)}${lgBox('X payouts', lgUsd(t.payoutUsd))}${lgBox('Received', `${t.received} · ${lgPkr(t.receivedPkr)}`)}${lgBox('Waiting', `${t.pending} · ${lgUsd(t.pendingUsd)}`)}</div>
    <div class="lgp-boxes">${lgBox('→ Payment Gateway', `${lgPkr(t.gateway)} (${lgUsd(t.gatewayUsd)})`)}${lgBox('→ Community Funds', `${lgPkr(t.community)} (${lgUsd(t.communityUsd)})`)}${lgBox('Expenses', lgPkr(t.expensesPkr))}${lgBox('Received − expenses', lgPkr(t.receivedPkr - t.expensesPkr))}</div>
    <h2>Balances${to ? ' on ' + lgDate(to > lgToday() ? lgToday() : to) : ' now'}</h2>
    <div class="lgp-boxes">${lgBox('Total balance', lgPkr(b.gateway + b.account + b.community))}${Object.keys(LG_POOLS).map(k => lgBox(LG_POOLS[k], lgPkr(b[k]))).join('')}</div>
    <h2>Members who got a payout (${mRows.length})</h2>
    ${mRows.length ? `<table><thead><tr><th>Member</th><th>Payouts</th><th>X payouts</th><th>Received</th><th>Received (Rs)</th></tr></thead><tbody>
      ${mRows.map(r => `<tr><td>${escapeHtml(r.name)}</td><td class="n">${r.n}</td><td class="n">${lgUsd(r.usd)}</td><td class="n">${r.rec}</td><td class="n">${lgPkr(r.pkr)}</td></tr>`).join('')}</tbody></table>` : '<div class="lgp-meta">No payouts in this period.</div>'}
    <h2>Payouts</h2>${lgPayoutTable(pays)}
    <h2>Expenses</h2>${lgExpenseTable(exps)}
    ${lgMovesTable(moves)}`;
}
function lgPrint(kind, o){
  let box = document.getElementById('ledgerPrint');
  if(!box){ box = document.createElement('div'); box.id = 'ledgerPrint'; document.body.appendChild(box); }
  box.innerHTML = lgReportHtml(kind, o || {});
  const old = document.title;
  document.title = `ledger-${kind}-${lgToday()}`; // the default PDF file name
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
      </div></div>`;
}
function lgSaveSettings(e){ e.preventDefault(); lgSend('PUT', '/ledger/settings', { usdRate: lgVal('lgSRate') }, 'Settings saved.'); return false; }
async function lgDownloadBackup(){
  try{
    const b = await apiGet('/ledger/backup');
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `bitbase-ledger-backup-${lgToday()}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }catch(err){ toast(err.message, true); }
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
