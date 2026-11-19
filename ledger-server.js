/* ===================== Ledger (admin only, password-locked) ===================== *
 * Members' X payouts in USD, the money received in PKR (split by the member's fixed
 * rate), expenses, and board entries (add / send / remove) between three pools:
 * Payment Gateway, Account and Community Funds.
 *
 * Rules (fixed): a member gives 20%, 15% or 5% of their X payout.
 *   20% -> the PKR received is split 15 parts Payment Gateway + 5 parts Community Funds
 *   15% -> all to Payment Gateway      5% -> all to Community Funds
 *
 * Storage: CSV files next to the rest of the data (DATA_DIR), written atomically.
 * Safety: every change also writes that day's full snapshot to
 * DATA_DIR/ledger_backups/ledger-YYYY-MM-DD.json (newest 90 days kept), and a restore
 * always snapshots the current data first, so nothing is lost by a bad edit or import.
 * Access: admins only, and only with the LEDGER password: a separate password, set the
 * first time the Ledger is opened (confirmed with the admin's login password), stored only
 * as a bcrypt hash in ledger_settings.json and never sent to the browser. Changing it
 * needs the current ledger password; a forgotten one is reset with the admin's login
 * password. An unlock lasts 10 minutes of inactivity, per browser session.
 * ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const RATES = { 20: { gateway: 15, community: 5 }, 15: { gateway: 15 }, 5: { community: 5 } };
const POOLS = ['gateway', 'account', 'community'];
const UNLOCK_MS = 10 * 60 * 1000;      // unlock ends after 10 minutes without ledger use
const MAX_TRIES = 5, LOCKOUT_MS = 5 * 60 * 1000;
const BACKUP_DAYS = 90;

const PAYOUT_COLS = ['id','member_id','member_name','date','usd','status','rate','received_pkr','received_date','note','created_by','created_at','updated_at'];
const EXPENSE_COLS = ['id','date','pkr','category','pool','note','created_by','created_at','updated_at'];
const MOVE_COLS = ['id','type','date','pkr','from_pool','to_pool','recipient','note','created_by','created_at','updated_at'];

function r2(n){ return Math.round((Number(n) || 0) * 100) / 100; }
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

// How a received PKR amount is split; the last pool takes the rounding remainder,
// so the parts always add up exactly to what was received.
function splitReceived(receivedPkr, rate){
  const parts = RATES[rate] || {};
  const total = Object.values(parts).reduce((s, v) => s + v, 0) || 1;
  const keys = Object.keys(parts);
  const out = { gateway: 0, account: 0, community: 0 };
  let used = 0;
  keys.forEach((k, i) => { out[k] = i === keys.length - 1 ? r2(receivedPkr - used) : r2(receivedPkr * parts[k] / total); used += out[k]; });
  return out;
}

module.exports = function registerLedger(app, d){
  const { DATA_DIR, readCsv, writeCsvAtomic, requireAuth, requireAdmin, getUser, allMembers, logAudit, uid } = d;
  const F = {
    payouts: path.join(DATA_DIR, 'ledger_payouts.csv'),
    expenses: path.join(DATA_DIR, 'ledger_expenses.csv'),
    moves: path.join(DATA_DIR, 'ledger_moves.csv'),
    settings: path.join(DATA_DIR, 'ledger_settings.json'),
  };
  const BACKUP_DIR = path.join(DATA_DIR, 'ledger_backups');

  /* ---------- files ---------- */
  if(!fs.existsSync(F.payouts)) writeCsvAtomic(F.payouts, PAYOUT_COLS, []);
  if(!fs.existsSync(F.expenses)) writeCsvAtomic(F.expenses, EXPENSE_COLS, []);
  if(!fs.existsSync(F.moves)) writeCsvAtomic(F.moves, MOVE_COLS, []);
  if(!fs.existsSync(F.settings)) fs.writeFileSync(F.settings, JSON.stringify({ usdRate: 280, memberRates: {} }, null, 2));

  const num = v => v === '' || v === undefined || v === null ? null : Number(v);
  let L = {
    payouts: readCsv(F.payouts).map(r => ({ id: r.id, memberId: r.member_id, memberName: r.member_name || '', date: r.date, usd: num(r.usd) || 0,
      status: r.status === 'received' ? 'received' : 'pending', rate: num(r.rate), receivedPkr: num(r.received_pkr) || 0, receivedDate: r.received_date || null,
      note: r.note || '', createdBy: r.created_by || '', createdAt: num(r.created_at), updatedAt: num(r.updated_at) })),
    expenses: readCsv(F.expenses).map(r => ({ id: r.id, date: r.date, pkr: num(r.pkr) || 0, category: r.category || 'Other', pool: r.pool,
      note: r.note || '', createdBy: r.created_by || '', createdAt: num(r.created_at), updatedAt: num(r.updated_at) })),
    moves: readCsv(F.moves).map(r => ({ id: r.id, type: r.type, date: r.date, pkr: num(r.pkr) || 0, from: r.from_pool || null, to: r.to_pool || null,
      recipient: r.recipient || '', note: r.note || '', createdBy: r.created_by || '', createdAt: num(r.created_at), updatedAt: num(r.updated_at) })),
    settings: Object.assign({ usdRate: 280, memberRates: {} }, JSON.parse(fs.readFileSync(F.settings, 'utf-8') || '{}')),
  };

  // Settings as the browser / a downloaded backup sees them: never the password hash.
  function publicSettings(){ const { passwordHash, ...rest } = L.settings; return rest; }
  function snapshot(withHash){ return { version: 1, savedAt: new Date().toISOString(), payouts: L.payouts, expenses: L.expenses, moves: L.moves,
    settings: withHash ? L.settings : publicSettings() }; }
  function backupToday(){
    try{
      if(!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const file = path.join(BACKUP_DIR, `ledger-${new Date().toISOString().slice(0, 10)}.json`);
      fs.writeFileSync(file + '.tmp', JSON.stringify(snapshot(true), null, 1)); fs.renameSync(file + '.tmp', file);
      const all = fs.readdirSync(BACKUP_DIR).filter(f => /^ledger-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      all.slice(0, Math.max(0, all.length - BACKUP_DAYS)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
    }catch(e){ console.error('Ledger backup failed:', e.message); }
  }
  function persist(){
    writeCsvAtomic(F.payouts, PAYOUT_COLS, L.payouts.map(p => ({ id: p.id, member_id: p.memberId, member_name: p.memberName, date: p.date, usd: p.usd,
      status: p.status, rate: p.rate === null ? '' : p.rate, received_pkr: p.status === 'received' ? p.receivedPkr : '', received_date: p.receivedDate || '',
      note: p.note, created_by: p.createdBy, created_at: p.createdAt, updated_at: p.updatedAt })));
    writeCsvAtomic(F.expenses, EXPENSE_COLS, L.expenses.map(e => ({ id: e.id, date: e.date, pkr: e.pkr, category: e.category, pool: e.pool, note: e.note,
      created_by: e.createdBy, created_at: e.createdAt, updated_at: e.updatedAt })));
    writeCsvAtomic(F.moves, MOVE_COLS, L.moves.map(m => ({ id: m.id, type: m.type, date: m.date, pkr: m.pkr, from_pool: m.from || '', to_pool: m.to || '',
      recipient: m.recipient, note: m.note, created_by: m.createdBy, created_at: m.createdAt, updated_at: m.updatedAt })));
    const tmp = F.settings + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(L.settings, null, 2)); fs.renameSync(tmp, F.settings);
    backupToday();
  }

  /* ---------- password unlock (per browser session) ---------- */
  const unlocks = new Map();   // session token -> expiry (ms)
  const tries = new Map();     // session token -> { n, until }
  const tokenOf = req => req.cookies && req.cookies.bb_session;
  function isUnlocked(req){
    const t = tokenOf(req), exp = t && unlocks.get(t);
    if(!exp || exp < Date.now()){ if(t) unlocks.delete(t); return false; }
    unlocks.set(t, Date.now() + UNLOCK_MS); // sliding: active use keeps it open
    return true;
  }
  function requireUnlocked(req, res, next){
    if(!isUnlocked(req)){ res.status(423).json({ error: 'ledger_locked' }); return; }
    next();
  }
  const guard = [requireAuth, requireAdmin, requireUnlocked];

  const hasPassword = () => !!L.settings.passwordHash;
  // Wrong-password limit, shared by unlock and password changes: 5 wrong -> wait 5 minutes.
  function tooManyTries(req, res){
    const tr = tries.get(tokenOf(req));
    if(tr && tr.until > Date.now()){ res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil((tr.until - Date.now()) / 60000)} min.` }); return true; }
    return false;
  }
  function wrongTry(req){
    const t = tokenOf(req), tr = tries.get(t) || { n: 0, until: 0 };
    tr.n++; if(tr.n >= MAX_TRIES){ tr.until = Date.now() + LOCKOUT_MS; tr.n = 0; }
    tries.set(t, tr);
  }

  app.get('/api/ledger/status', requireAuth, requireAdmin, (req, res) => res.json({ unlocked: hasPassword() && isUnlocked(req), hasPassword: hasPassword() }));

  app.post('/api/ledger/unlock', requireAuth, requireAdmin, (req, res) => {
    if(!hasPassword()){ res.status(409).json({ error: 'no_ledger_password' }); return; }
    if(tooManyTries(req, res)) return;
    if(!bcrypt.compareSync(String((req.body || {}).password || ''), L.settings.passwordHash)){
      wrongTry(req); res.status(401).json({ error: 'Wrong ledger password.' }); return;
    }
    tries.delete(tokenOf(req));
    unlocks.set(tokenOf(req), Date.now() + UNLOCK_MS);
    res.json({ unlocked: true });
  });

  // Set (first time), change (current ledger password) or reset (admin login password).
  app.post('/api/ledger/password', requireAuth, requireAdmin, (req, res) => {
    if(tooManyTries(req, res)) return;
    const { newPassword, currentPassword, accountPassword } = req.body || {};
    const np = String(newPassword || '');
    if(np.length < 6){ res.status(400).json({ error: 'The ledger password must be at least 6 characters.' }); return; }
    const byAccount = !!accountPassword && bcrypt.compareSync(String(accountPassword), req.user.passwordHash);
    const byCurrent = hasPassword() && !!currentPassword && bcrypt.compareSync(String(currentPassword), L.settings.passwordHash);
    if(!(byAccount || byCurrent)){
      wrongTry(req);
      res.status(401).json({ error: hasPassword() ? 'Enter the current ledger password (or your admin login password if you forgot it).' : 'Enter your admin login password to confirm.' });
      return;
    }
    if(bcrypt.compareSync(np, req.user.passwordHash)){ res.status(400).json({ error: 'Use a different password from your admin login.' }); return; }
    const first = !hasPassword();
    L.settings.passwordHash = bcrypt.hashSync(np, 10);
    persist();
    unlocks.clear();                                  // every other browser has to use the new password
    tries.delete(tokenOf(req));
    unlocks.set(tokenOf(req), Date.now() + UNLOCK_MS);
    logAudit(req.user.displayName, first ? 'Ledger: set the ledger password' : (byCurrent ? 'Ledger: changed the ledger password' : 'Ledger: reset the ledger password (with the admin login)'), '');
    res.json({ unlocked: true });
  });
  app.post('/api/ledger/lock', requireAuth, (req, res) => { unlocks.delete(tokenOf(req)); res.json({ unlocked: false }); });

  /* ---------- read ---------- */
  function membersList(){
    // Every member is sent (old payouts keep their names); the page only offers monetized ones.
    return allMembers().map(m => ({ id: m.id, name: m.displayName, username: m.username, xUsername: m.xUsername || '', status: m.status, monetized: !!m.monetized,
      rate: RATES[L.settings.memberRates[m.id]] ? Number(L.settings.memberRates[m.id]) : 20 }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  app.get('/api/ledger', guard, (req, res) => {
    res.json({ payouts: L.payouts, expenses: L.expenses, moves: L.moves, settings: publicSettings(), members: membersList() });
  });

  /* ---------- payouts ---------- */
  function payoutFields(body, existing){
    const usd = r2(body.usd), date = body.date, memberId = body.memberId;
    const m = getUser(memberId);
    if(!existing && (!m || m.role !== 'member')) return { error: 'Pick a member.' };
    if(!existing && !m.monetized) return { error: 'Only monetized members get payouts. Mark them monetized on the Members page first.' };
    if(!(usd > 0)) return { error: 'Enter the payout in USD (above 0).' };
    if(!isDate(date)) return { error: 'Enter a valid payout day.' };
    const out = { usd, date, note: String(body.note || '').trim().slice(0, 300) };
    if(m && m.role === 'member'){ out.memberId = memberId; out.memberName = m.displayName; }
    return { ok: out };
  }
  app.post('/api/ledger/payouts', guard, (req, res) => {
    const f = payoutFields(req.body || {}); if(f.error){ res.status(400).json({ error: f.error }); return; }
    const p = Object.assign({ id: uid('lp'), status: 'pending', rate: null, receivedPkr: 0, receivedDate: null, createdBy: req.user.displayName,
      createdAt: Date.now(), updatedAt: Date.now() }, f.ok);
    L.payouts.push(p); persist();
    logAudit(req.user.displayName, `Ledger: added ${p.memberName}'s $${p.usd} payout (${p.date})`, p.memberName);
    res.json({ payout: p });
  });
  app.put('/api/ledger/payouts/:id', guard, (req, res) => {
    const p = L.payouts.find(x => x.id === req.params.id); if(!p){ res.status(404).json({ error: 'Payout not found.' }); return; }
    const f = payoutFields(Object.assign({ memberId: p.memberId }, req.body || {}), p); if(f.error){ res.status(400).json({ error: f.error }); return; }
    Object.assign(p, f.ok, { updatedAt: Date.now() }); persist();
    logAudit(req.user.displayName, `Ledger: edited ${p.memberName}'s payout (${p.date}, $${p.usd})`, p.memberName);
    res.json({ payout: p });
  });
  app.post('/api/ledger/payouts/:id/receive', guard, (req, res) => {
    const p = L.payouts.find(x => x.id === req.params.id); if(!p){ res.status(404).json({ error: 'Payout not found.' }); return; }
    const { receivedPkr, rate, receivedDate } = req.body || {};
    const amount = r2(receivedPkr), rt = Number(rate);
    if(!(amount > 0)){ res.status(400).json({ error: 'Enter the PKR received (above 0).' }); return; }
    if(!RATES[rt]){ res.status(400).json({ error: 'The rate must be 20%, 15% or 5%.' }); return; }
    if(!isDate(receivedDate)){ res.status(400).json({ error: 'Enter a valid received date.' }); return; }
    Object.assign(p, { status: 'received', receivedPkr: amount, rate: rt, receivedDate, updatedAt: Date.now() });
    L.settings.memberRates[p.memberId] = rt; // remember the member's rate for next time
    persist();
    const s = splitReceived(amount, rt);
    logAudit(req.user.displayName, `Ledger: received Rs ${amount} for ${p.memberName}'s $${p.usd} payout (${rt}%: gateway Rs ${s.gateway}, community Rs ${s.community})`, p.memberName);
    res.json({ payout: p });
  });
  app.post('/api/ledger/payouts/:id/unreceive', guard, (req, res) => {
    const p = L.payouts.find(x => x.id === req.params.id); if(!p){ res.status(404).json({ error: 'Payout not found.' }); return; }
    Object.assign(p, { status: 'pending', receivedPkr: 0, rate: null, receivedDate: null, updatedAt: Date.now() }); persist();
    logAudit(req.user.displayName, `Ledger: set ${p.memberName}'s $${p.usd} payout back to waiting`, p.memberName);
    res.json({ payout: p });
  });
  app.delete('/api/ledger/payouts/:id', guard, (req, res) => {
    const p = L.payouts.find(x => x.id === req.params.id); if(!p){ res.status(404).json({ error: 'Payout not found.' }); return; }
    L.payouts = L.payouts.filter(x => x.id !== p.id); persist();
    logAudit(req.user.displayName, `Ledger: deleted ${p.memberName}'s $${p.usd} payout (${p.date})`, p.memberName);
    res.json({ ok: true });
  });

  /* ---------- expenses ---------- */
  function expenseFields(b){
    const pkr = r2(b.pkr);
    if(!(pkr > 0)) return { error: 'Enter an amount above 0.' };
    if(!isDate(b.date)) return { error: 'Enter a valid date.' };
    if(!POOLS.includes(b.pool)) return { error: 'Pick where it was paid from.' };
    return { ok: { pkr, date: b.date, pool: b.pool, category: String(b.category || 'Other').slice(0, 60), note: String(b.note || '').trim().slice(0, 300) } };
  }
  app.post('/api/ledger/expenses', guard, (req, res) => {
    const f = expenseFields(req.body || {}); if(f.error){ res.status(400).json({ error: f.error }); return; }
    const e = Object.assign({ id: uid('le'), createdBy: req.user.displayName, createdAt: Date.now(), updatedAt: Date.now() }, f.ok);
    L.expenses.push(e); persist();
    logAudit(req.user.displayName, `Ledger: expense Rs ${e.pkr} (${e.category}) from ${e.pool}`, '');
    res.json({ expense: e });
  });
  app.put('/api/ledger/expenses/:id', guard, (req, res) => {
    const e = L.expenses.find(x => x.id === req.params.id); if(!e){ res.status(404).json({ error: 'Expense not found.' }); return; }
    const f = expenseFields(req.body || {}); if(f.error){ res.status(400).json({ error: f.error }); return; }
    Object.assign(e, f.ok, { updatedAt: Date.now() }); persist();
    logAudit(req.user.displayName, `Ledger: edited an expense (Rs ${e.pkr}, ${e.category})`, '');
    res.json({ expense: e });
  });
  app.delete('/api/ledger/expenses/:id', guard, (req, res) => {
    const e = L.expenses.find(x => x.id === req.params.id); if(!e){ res.status(404).json({ error: 'Expense not found.' }); return; }
    L.expenses = L.expenses.filter(x => x.id !== e.id); persist();
    logAudit(req.user.displayName, `Ledger: deleted an expense (Rs ${e.pkr}, ${e.category})`, '');
    res.json({ ok: true });
  });

  /* ---------- board entries: add / send / remove ---------- */
  function moveFields(b){
    const type = b.type, pkr = r2(b.pkr);
    if(!['add', 'send', 'remove'].includes(type)) return { error: 'Unknown entry type.' };
    if(!(pkr > 0)) return { error: 'Enter an amount above 0.' };
    if(!isDate(b.date)) return { error: 'Enter a valid date.' };
    const from = type === 'add' ? null : b.from, to = type === 'remove' ? null : b.to;
    if(type !== 'add' && !POOLS.includes(from)) return { error: 'Pick where the money comes from.' };
    if(type === 'add' && !POOLS.includes(to)) return { error: 'Pick where the money goes.' };
    if(type === 'send' && !(POOLS.includes(to) || to === 'outside')) return { error: 'Pick where the money goes.' };
    if(type === 'send' && from === to) return { error: 'From and To are the same pool.' };
    return { ok: { type, pkr, date: b.date, from, to, recipient: to === 'outside' ? String(b.recipient || '').trim().slice(0, 80) : '', note: String(b.note || '').trim().slice(0, 300) } };
  }
  app.post('/api/ledger/moves', guard, (req, res) => {
    const f = moveFields(req.body || {}); if(f.error){ res.status(400).json({ error: f.error }); return; }
    const m = Object.assign({ id: uid('lm'), createdBy: req.user.displayName, createdAt: Date.now(), updatedAt: Date.now() }, f.ok);
    L.moves.push(m); persist();
    logAudit(req.user.displayName, `Ledger: ${m.type} Rs ${m.pkr}${m.from ? ' from ' + m.from : ''}${m.to ? ' to ' + (m.to === 'outside' ? (m.recipient || 'outside') : m.to) : ''}`, '');
    res.json({ move: m });
  });
  app.put('/api/ledger/moves/:id', guard, (req, res) => {
    const m = L.moves.find(x => x.id === req.params.id); if(!m){ res.status(404).json({ error: 'Entry not found.' }); return; }
    const f = moveFields(Object.assign({ type: m.type }, req.body || {})); if(f.error){ res.status(400).json({ error: f.error }); return; }
    Object.assign(m, f.ok, { updatedAt: Date.now() }); persist();
    logAudit(req.user.displayName, `Ledger: edited a ${m.type} entry (Rs ${m.pkr})`, '');
    res.json({ move: m });
  });
  app.delete('/api/ledger/moves/:id', guard, (req, res) => {
    const m = L.moves.find(x => x.id === req.params.id); if(!m){ res.status(404).json({ error: 'Entry not found.' }); return; }
    L.moves = L.moves.filter(x => x.id !== m.id); persist();
    logAudit(req.user.displayName, `Ledger: deleted a ${m.type} entry (Rs ${m.pkr})`, '');
    res.json({ ok: true });
  });

  /* ---------- settings ---------- */
  app.put('/api/ledger/settings', guard, (req, res) => {
    const { usdRate, memberRates } = req.body || {};
    if(usdRate !== undefined){
      const r = r2(usdRate); if(!(r >= 0)){ res.status(400).json({ error: 'The USD rate must be a number.' }); return; }
      L.settings.usdRate = r;
    }
    if(memberRates && typeof memberRates === 'object'){
      Object.keys(memberRates).forEach(id => { const rt = Number(memberRates[id]); if(RATES[rt] && getUser(id)) L.settings.memberRates[id] = rt; });
    }
    persist();
    logAudit(req.user.displayName, 'Ledger: updated settings', '');
    res.json({ settings: publicSettings() });
  });

  /* ---------- backup / restore ---------- */
  app.get('/api/ledger/backup', guard, (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="bitbase-ledger-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(snapshot());
  });
  // Accepts a backup from this site, or one downloaded from the sandbox (its members are
  // matched to site members by X username, username or name). confirm:false = preview only.
  app.post('/api/ledger/restore', guard, (req, res) => {
    const { backup, confirm } = req.body || {};
    if(!backup || !Array.isArray(backup.payouts)){ res.status(400).json({ error: 'That file is not a ledger backup.' }); return; }
    const members = allMembers();
    const norm = s => String(s || '').trim().toLowerCase().replace(/^@/, '');
    const sandboxMembers = Array.isArray(backup.members) ? backup.members : [];
    const matchId = oldId => {
      if(getUser(oldId) && getUser(oldId).role === 'member') return oldId;
      const sm = sandboxMembers.find(m => m.id === oldId); if(!sm) return null;
      const hit = members.find(m => (sm.handle && (norm(m.xUsername) === norm(sm.handle) || norm(m.username) === norm(sm.handle))) || norm(m.displayName) === norm(sm.name));
      return hit ? hit.id : null;
    };
    const skipped = [];
    const payouts = backup.payouts.map(p => {
      const memberId = matchId(p.memberId);
      if(!memberId){ skipped.push((sandboxMembers.find(m => m.id === p.memberId) || {}).name || p.memberName || p.memberId); return null; }
      const status = p.status === 'received' && RATES[Number(p.rate)] ? 'received' : 'pending';
      return { id: p.id || uid('lp'), memberId, memberName: getUser(memberId).displayName, date: isDate(p.date) ? p.date : new Date().toISOString().slice(0, 10),
        usd: r2(p.usd), status, rate: status === 'received' ? Number(p.rate) : null, receivedPkr: status === 'received' ? r2(p.receivedPkr) : 0,
        receivedDate: status === 'received' && isDate(p.receivedDate) ? p.receivedDate : (status === 'received' ? p.date : null),
        note: String(p.note || ''), createdBy: p.createdBy || req.user.displayName, createdAt: p.createdAt || Date.now(), updatedAt: Date.now() };
    }).filter(Boolean);
    const expenses = (backup.expenses || []).filter(e => r2(e.pkr) > 0 && POOLS.includes(e.pool)).map(e => ({ id: e.id || uid('le'), date: isDate(e.date) ? e.date : new Date().toISOString().slice(0, 10),
      pkr: r2(e.pkr), category: String(e.category || 'Other'), pool: e.pool, note: String(e.note || ''), createdBy: e.createdBy || req.user.displayName, createdAt: e.createdAt || Date.now(), updatedAt: Date.now() }));
    const moves = (backup.moves || []).map(m => moveFields(m).ok ? Object.assign({ id: m.id || uid('lm'), createdBy: m.createdBy || req.user.displayName, createdAt: m.createdAt || Date.now(), updatedAt: Date.now() }, moveFields(m).ok) : null).filter(Boolean);
    const preview = { payouts: payouts.length, expenses: expenses.length, moves: moves.length, skipped: [...new Set(skipped)] };
    if(!confirm){ res.json({ preview }); return; }
    // keep what's there now, then replace
    try{
      if(!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.writeFileSync(path.join(BACKUP_DIR, `before-restore-${Date.now()}.json`), JSON.stringify(snapshot(true), null, 1));
    }catch(e){ res.status(500).json({ error: 'Could not save a safety copy first, so nothing was changed.' }); return; }
    L.payouts = payouts; L.expenses = expenses; L.moves = moves;
    if(backup.settings && backup.settings.usdRate !== undefined) L.settings.usdRate = r2(backup.settings.usdRate);
    if(backup.settings && backup.settings.memberRates) Object.keys(backup.settings.memberRates).forEach(id => { if(getUser(id) && RATES[Number(backup.settings.memberRates[id])]) L.settings.memberRates[id] = Number(backup.settings.memberRates[id]); });
    sandboxMembers.forEach(sm => { const id = matchId(sm.id); if(id && RATES[Number(sm.rate)]) L.settings.memberRates[id] = Number(sm.rate); });
    persist();
    logAudit(req.user.displayName, `Ledger: restored a backup (${payouts.length} payouts, ${expenses.length} expenses, ${moves.length} board entries)`, '');
    res.json({ preview, restored: true });
  });

  return { lockSession: token => unlocks.delete(token) };
};
module.exports.splitReceived = splitReceived;
module.exports.RATES = RATES;
