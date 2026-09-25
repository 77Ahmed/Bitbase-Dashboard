/* ===================== Bitbase server ===================== *
 * Node/Express backend. All data (users, daily activity, audit
 * logs) is stored in plain CSV files under ./data, so it's easy
 * to inspect, back up, or edit by hand with Excel/Sheets if you
 * ever need to. Passwords are bcrypt-hashed before they ever
 * touch a file. Sessions are a random token in an httpOnly cookie,
 * kept in memory (they reset if you restart the server).
 * ============================================================ */
'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const USERS_CSV = path.join(DATA_DIR, 'users.csv');
const ACTIVITY_CSV = path.join(DATA_DIR, 'daily_activity.csv');
const AUDIT_CSV = path.join(DATA_DIR, 'audit_logs.csv');
const PAYOUTS_CSV = path.join(DATA_DIR, 'payouts.csv');
const SETTINGS_JSON = path.join(DATA_DIR, 'settings.json');

const USER_COLUMNS = ['id','username','password_hash','display_name','role','status','x_username','whatsapp','moderator_id','assigned_percentage','monetized','permissions_json','created_at'];
const ACTIVITY_COLUMNS = ['id','user_id','date','posts','manual_percentage','reason','source','created_by','updated_by','created_at','updated_at'];
const AUDIT_COLUMNS = ['id','time','actor','action','target_name'];
const PAYOUT_COLUMNS = ['id','user_id','date','amount','monetized','type','note','awarded_by','created_at'];

/* ---------------- CSV read/write ---------------- */
function readCsv(file){
  const raw = fs.readFileSync(file, 'utf-8');
  if(!raw.trim()) return [];
  return parse(raw, { columns: true, skip_empty_lines: true });
}
function writeCsvAtomic(file, columns, rows){
  const out = stringify(rows, { header: true, columns });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file); // atomic on the same filesystem — avoids a half-written file if the process dies mid-write
}

function ensureDataFiles(){
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if(!fs.existsSync(USERS_CSV)) writeCsvAtomic(USERS_CSV, USER_COLUMNS, []);
  if(!fs.existsSync(ACTIVITY_CSV)) writeCsvAtomic(ACTIVITY_CSV, ACTIVITY_COLUMNS, []);
  if(!fs.existsSync(AUDIT_CSV)) writeCsvAtomic(AUDIT_CSV, AUDIT_COLUMNS, []);
  if(!fs.existsSync(PAYOUTS_CSV)) writeCsvAtomic(PAYOUTS_CSV, PAYOUT_COLUMNS, []);
  if(!fs.existsSync(SETTINGS_JSON)) fs.writeFileSync(SETTINGS_JSON, JSON.stringify({ communityName:'', timezone:'Asia/Karachi' }, null, 2));
}

/* ---------------- Row <-> object mapping ---------------- */
function rowToUser(r){
  return {
    id: r.id, username: r.username, passwordHash: r.password_hash, displayName: r.display_name,
    role: r.role, status: r.status, xUsername: r.x_username || '', whatsapp: r.whatsapp || '',
    moderatorId: r.moderator_id || null, assignedPercentage: r.assigned_percentage!==undefined && r.assigned_percentage!=='' ? Number(r.assigned_percentage) : 50,
    monetized: r.monetized==='true' || r.monetized===true,
    permissions: r.permissions_json ? JSON.parse(r.permissions_json) : null,
    createdAt: Number(r.created_at) || Date.now()
  };
}
function userToRow(u){
  return { id:u.id, username:u.username, password_hash:u.passwordHash, display_name:u.displayName, role:u.role, status:u.status,
    x_username:u.xUsername||'', whatsapp:u.whatsapp||'', moderator_id:u.moderatorId||'', assigned_percentage: u.role==='member' ? (u.assignedPercentage!==undefined&&u.assignedPercentage!==null?u.assignedPercentage:50) : '',
    monetized: u.role==='member' ? (u.monetized?'true':'false') : '',
    permissions_json: u.permissions?JSON.stringify(u.permissions):'', created_at:u.createdAt };
}
function rowToActivity(r){
  return { id:r.id, userId:r.user_id, date:r.date, posts: r.posts===''?null:Number(r.posts),
    manualPercentage: r.manual_percentage===''?null:Number(r.manual_percentage), reason: r.reason || null, source: r.source,
    createdBy: r.created_by, updatedBy: r.updated_by, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}
function activityToRow(a){
  return { id:a.id, user_id:a.userId, date:a.date, posts: a.posts===null||a.posts===undefined?'':a.posts,
    manual_percentage: a.manualPercentage===null||a.manualPercentage===undefined?'':a.manualPercentage,
    reason:a.reason||'', source:a.source, created_by:a.createdBy, updated_by:a.updatedBy, created_at:a.createdAt, updated_at:a.updatedAt };
}
function rowToAudit(r){ return { id:r.id, time:Number(r.time), actor:r.actor, action:r.action, targetName:r.target_name||'' }; }
function auditToRow(l){ return { id:l.id, time:l.time, actor:l.actor, action:l.action, target_name:l.targetName||'' }; }
function rowToPayout(r){
  return { id:r.id, userId:r.user_id, date:r.date, amount: r.amount===''?0:Number(r.amount), monetized: r.monetized==='true'||r.monetized===true,
    type: r.type || 'premium', note: r.note || '', awardedBy: r.awarded_by || '', createdAt: Number(r.created_at) || Date.now() };
}
function payoutToRow(p){
  return { id:p.id, user_id:p.userId, date:p.date, amount:p.amount||0, monetized: p.monetized?'true':'false', type:p.type||'premium', note:p.note||'', awarded_by:p.awardedBy||'', created_at:p.createdAt };
}

/* ---------------- In-memory mirror, write-through to CSV ---------------- */
let users = [];
let activity = [];
let auditLogs = [];
let payouts = [];
let settings = {};

function loadAll(){
  ensureDataFiles();
  users = readCsv(USERS_CSV).map(rowToUser);
  activity = readCsv(ACTIVITY_CSV).map(rowToActivity);
  auditLogs = readCsv(AUDIT_CSV).map(rowToAudit);
  payouts = readCsv(PAYOUTS_CSV).map(rowToPayout);
  settings = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf-8'));
}
function persistUsers(){ writeCsvAtomic(USERS_CSV, USER_COLUMNS, users.map(userToRow)); }
function persistActivity(){ writeCsvAtomic(ACTIVITY_CSV, ACTIVITY_COLUMNS, activity.map(activityToRow)); }
function persistAudit(){ writeCsvAtomic(AUDIT_CSV, AUDIT_COLUMNS, auditLogs.map(auditToRow)); }
function persistPayouts(){ writeCsvAtomic(PAYOUTS_CSV, PAYOUT_COLUMNS, payouts.map(payoutToRow)); }
function persistSettings(){ fs.writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2)); }

/* ---------------- Small helpers (mirrors of the frontend's own logic) ---------------- */
function uid(prefix){ return prefix + '_' + crypto.randomBytes(6).toString('hex'); }
function normalizeUsername(u){ return (u||'').trim().toLowerCase().replace(/^@/, ''); }
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
function dateStr(offsetDays){
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays||0));
  return d.toISOString().slice(0,10);
}
function last7Dates(endOffset){
  const arr = [];
  for(let i=6;i>=0;i--) arr.push(dateStr((endOffset||0)-i));
  return arr;
}

function getUser(id){ return users.find(u=>u.id===id); }
function getUserByUsername(username){
  const n = normalizeUsername(username);
  return users.find(u=>normalizeUsername(u.username)===n);
}
function hasAdmin(){ return users.some(u=>u.role==='admin'); }
function membersOf(moderatorId){ return users.filter(u=>u.role==='member' && u.moderatorId===moderatorId); }
function allMembers(){ return users.filter(u=>u.role==='member'); }
function allModerators(){ return users.filter(u=>u.role==='moderator'); }

function scopeIdsFor(viewer){
  if(!viewer) return [];
  if(viewer.role==='admin') return allMembers().map(m=>m.id);
  if(viewer.role==='moderator') return membersOf(viewer.id).map(m=>m.id);
  if(viewer.role==='member') return [viewer.id];
  return [];
}
function canModeratorAct(viewer, perm){
  if(!viewer) return false;
  if(viewer.role==='admin') return true;
  if(viewer.role==='moderator') return !!(viewer.permissions && viewer.permissions[perm]);
  return false;
}

function publicUser(u){
  if(!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function getRecord(userId, date){ return activity.find(r=>r.userId===userId && r.date===date) || null; }
function dailyCommunityTotal(date){
  let total = 0;
  activity.forEach(r=>{
    if(r.date!==date) return;
    if(r.posts===null || r.posts===undefined) return;
    const u = getUser(r.userId);
    if(!u || u.status!=='active') return;
    total += r.posts;
  });
  return total;
}
function effectivePercentage(rec){
  if(!rec) return null;
  if(rec.manualPercentage!==null && rec.manualPercentage!==undefined) return rec.manualPercentage;
  const total = dailyCommunityTotal(rec.date);
  if(rec.posts===null || rec.posts===undefined) return 0;
  return total>0 ? Math.round((rec.posts/total)*1000)/10 : 0;
}

/* ---------------- Audit log ---------------- */
function logAudit(actorName, action, targetName){
  auditLogs.unshift({ id: uid('log'), time: Date.now(), actor: actorName || 'System', action, targetName: targetName || '' });
  if(auditLogs.length > 500) auditLogs.length = 500;
  persistAudit();
}

/* ---------------- Sessions ---------------- */
const sessions = new Map(); // token -> userId
function createSession(userId){
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, userId);
  return token;
}
function destroySession(token){ sessions.delete(token); }
function getSessionUser(req){
  const token = req.cookies && req.cookies.bb_session;
  if(!token) return null;
  const userId = sessions.get(token);
  if(!userId) return null;
  const u = getUser(userId);
  return (u && u.status === 'active') ? u : null;
}

const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 };

/* ---------------- App ---------------- */
loadAll();
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

function requireAuth(req, res, next){
  const u = getSessionUser(req);
  if(!u){ res.status(401).json({ error: 'Not logged in.' }); return; }
  req.user = u;
  next();
}
function requireAdmin(req, res, next){
  if(req.user.role !== 'admin'){ res.status(403).json({ error: 'Admins only.' }); return; }
  next();
}

/* ===== Bootstrap / auth ===== */

app.get('/api/state', (req, res) => {
  const viewer = getSessionUser(req);
  if(!viewer){
    res.json({ authenticated:false, hasAdmin: hasAdmin(), settings: { communityName: settings.communityName }, users: [], dailyActivity: [], auditLogs: [], directory: [] });
    return;
  }

  // Every logged-in viewer (admin, moderator, or member) now sees the full
  // member/moderator roster and everyone's daily activity — this is
  // intentionally community-wide, read-only visibility. WRITE endpoints
  // (POST/PUT/DELETE /api/users, POST /api/activity, imports) still enforce
  // each role's real edit scope and permissions independently, server-side.
  const visibleUsers = users;
  const visibleActivity = activity;

  // Minimal public roster — every active member's name/username/X/target, visible to
  // the whole community regardless of role (not full profiles, no contact/status/permission data).
  const directory = allMembers().filter(m=>m.status==='active').map(m => ({ id:m.id, displayName:m.displayName, username:m.username, xUsername:m.xUsername||'', assignedPercentage:m.assignedPercentage, monetized:!!m.monetized }));

  res.json({
    authenticated: true,
    hasAdmin: true,
    session: { currentUserId: viewer.id },
    users: visibleUsers.map(publicUser),
    dailyActivity: visibleActivity,
    auditLogs: viewer.role==='member' ? [] : auditLogs,
    directory,
    settings
  });
});

app.post('/api/setup', (req, res) => {
  if(hasAdmin()){ res.status(400).json({ error: 'Setup has already been completed.' }); return; }
  const { communityName, displayName, username, password } = req.body || {};
  const uname = normalizeUsername(username);
  if(!uname || !displayName || !password || password.length < 6){
    res.status(400).json({ error: 'Please fill in all fields (password must be at least 6 characters).' });
    return;
  }
  const admin = {
    id: uid('u'), username: uname, passwordHash: bcrypt.hashSync(password, 10), displayName: displayName.trim(),
    role: 'admin', status: 'active', xUsername: '', whatsapp: '', moderatorId: null, permissions: null, createdAt: Date.now()
  };
  users.push(admin);
  persistUsers();
  settings.communityName = (communityName || '').trim() || 'My Community';
  persistSettings();
  logAudit(admin.displayName, `Created the community and the first Admin account (@${admin.username})`, '');
  const token = createSession(admin.id);
  res.cookie('bb_session', token, COOKIE_OPTS);
  res.json({ user: publicUser(admin) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = getUserByUsername(username);
  if(!u || !bcrypt.compareSync(password || '', u.passwordHash)){
    res.status(401).json({ error: 'Incorrect username or password.' });
    return;
  }
  if(u.status !== 'active'){
    res.status(403).json({ error: 'This account has been deactivated. Contact an admin.' });
    return;
  }
  const token = createSession(u.id);
  res.cookie('bb_session', token, COOKIE_OPTS);
  res.json({ user: publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies && req.cookies.bb_session;
  if(token) destroySession(token);
  res.clearCookie('bb_session');
  res.json({ ok: true });
});

/* ===== Users (members + moderators) ===== */

app.post('/api/users', requireAuth, (req, res) => {
  const actor = req.user;
  const { role, username, password, displayName, xUsername, whatsapp, moderatorId, permissions, assignedPercentage, monetized } = req.body || {};
  const uname = normalizeUsername(username);
  if(!uname || !displayName){ res.status(400).json({ error: 'Username and display name are required.' }); return; }
  if(getUserByUsername(uname)){ res.status(409).json({ error: 'That username is already taken.' }); return; }

  if(role === 'moderator'){
    if(actor.role !== 'admin'){ res.status(403).json({ error: 'Only admins can create moderators.' }); return; }
    const mod = {
      id: uid('u'), username: uname, passwordHash: bcrypt.hashSync(password || 'changeme123', 10), displayName: displayName.trim(),
      role: 'moderator', status: 'active', xUsername: normalizeUsername(xUsername||''), whatsapp: (whatsapp||'').replace(/\D/g,''),
      moderatorId: null, permissions: permissions || { addMembers:true, editMembers:true, removeMembers:false, viewWeekly:true },
      createdAt: Date.now()
    };
    users.push(mod); persistUsers();
    logAudit(actor.displayName, `Created new moderator: ${mod.displayName} (@${mod.username})`, mod.displayName);
    res.json({ user: publicUser(mod) });
    return;
  }

  // role === 'member'
  if(!(actor.role==='admin' || canModeratorAct(actor,'addMembers'))){ res.status(403).json({ error: 'You do not have permission to add members.' }); return; }
  const assignedModeratorId = actor.role==='admin' ? (moderatorId || null) : actor.id;
  const pctRaw = assignedPercentage===undefined || assignedPercentage===null || assignedPercentage==='' ? 50 : Number(assignedPercentage);
  if(isNaN(pctRaw) || pctRaw < 10 || pctRaw > 100){ res.status(400).json({ error: 'Assigned percentage must be between 10 and 100.' }); return; }
  const member = {
    id: uid('u'), username: uname, passwordHash: bcrypt.hashSync(password || 'changeme123', 10), displayName: displayName.trim(),
    role: 'member', status: 'active', xUsername: normalizeUsername(xUsername||''), whatsapp: (whatsapp||'').replace(/\D/g,''),
    moderatorId: assignedModeratorId, assignedPercentage: clamp(pctRaw,10,100), monetized: !!monetized, permissions: null, createdAt: Date.now()
  };
  users.push(member); persistUsers();
  logAudit(actor.displayName, `Created new member: ${member.displayName} (@${member.username}) \u2014 assigned ${member.assignedPercentage}%`, member.displayName);
  res.json({ user: publicUser(member) });
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  const actor = req.user;
  const target = getUser(req.params.id);
  if(!target){ res.status(404).json({ error: 'Not found.' }); return; }

  if(target.role === 'moderator'){
    if(actor.role !== 'admin'){ res.status(403).json({ error: 'Only admins can edit moderators.' }); return; }
  }else if(target.role === 'member'){
    const inScope = actor.role==='admin' || (actor.role==='moderator' && target.moderatorId===actor.id);
    if(!inScope || !(actor.role==='admin' || canModeratorAct(actor,'editMembers'))){
      res.status(403).json({ error: 'You do not have permission to edit this member.' }); return;
    }
  }else{
    res.status(403).json({ error: 'Cannot edit this account.' }); return;
  }

  const { username, password, displayName, xUsername, whatsapp, moderatorId, permissions, assignedPercentage, monetized } = req.body || {};
  if(username !== undefined){
    const uname = normalizeUsername(username);
    const existing = getUserByUsername(uname);
    if(existing && existing.id !== target.id){ res.status(409).json({ error: 'That username is already taken.' }); return; }
    target.username = uname;
  }
  if(displayName !== undefined) target.displayName = displayName.trim();
  if(xUsername !== undefined) target.xUsername = normalizeUsername(xUsername);
  if(whatsapp !== undefined) target.whatsapp = (whatsapp||'').replace(/\D/g,'');
  if(password) target.passwordHash = bcrypt.hashSync(password, 10);
  if(target.role==='member' && actor.role==='admin' && moderatorId !== undefined) target.moderatorId = moderatorId || null;
  if(target.role==='moderator' && actor.role==='admin' && permissions) target.permissions = permissions;
  if(target.role==='member' && assignedPercentage !== undefined){
    const pct = Number(assignedPercentage);
    if(isNaN(pct) || pct < 10 || pct > 100){ res.status(400).json({ error: 'Assigned percentage must be between 10 and 100.' }); return; }
    target.assignedPercentage = clamp(pct,10,100);
  }
  if(target.role==='member' && monetized !== undefined) target.monetized = !!monetized;

  persistUsers();
  logAudit(actor.displayName, `Updated ${target.role} profile for ${target.displayName}`, target.displayName);
  res.json({ user: publicUser(target) });
});

app.put('/api/users/:id/status', requireAuth, (req, res) => {
  const actor = req.user;
  const target = getUser(req.params.id);
  if(!target){ res.status(404).json({ error: 'Not found.' }); return; }

  if(target.role==='moderator'){
    if(actor.role !== 'admin'){ res.status(403).json({ error: 'Only admins can deactivate moderators.' }); return; }
    if(target.status==='active'){
      const memberList = membersOf(target.id);
      const reassignTo = req.body && req.body.reassignTo;
      if(memberList.length && reassignTo === undefined){
        res.status(409).json({ error: 'needs_reassignment', memberCount: memberList.length }); return;
      }
      memberList.forEach(m => m.moderatorId = reassignTo || null);
      target.status = 'inactive';
      persistUsers();
      logAudit(actor.displayName, `Deactivated moderator ${target.displayName}${memberList.length?` and reassigned ${memberList.length} members`:''}`, target.displayName);
    }else{
      target.status = 'active';
      persistUsers();
      logAudit(actor.displayName, `Reactivated moderator ${target.displayName}`, target.displayName);
    }
    res.json({ user: publicUser(target) });
    return;
  }

  // member
  const inScope = actor.role==='admin' || (actor.role==='moderator' && target.moderatorId===actor.id);
  if(!inScope || !(actor.role==='admin' || canModeratorAct(actor,'removeMembers'))){
    res.status(403).json({ error: 'You do not have permission to change this member\u2019s status.' }); return;
  }
  target.status = target.status==='active' ? 'inactive' : 'active';
  persistUsers();
  logAudit(actor.displayName, `${target.status==='inactive'?'Deactivated':'Reactivated'} member ${target.displayName}`, target.displayName);
  res.json({ user: publicUser(target) });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = getUser(req.params.id);
  if(!target || target.role !== 'member'){ res.status(404).json({ error: 'Not found.' }); return; }
  users = users.filter(u => u.id !== target.id);
  activity = activity.filter(r => r.userId !== target.id);
  persistUsers(); persistActivity();
  logAudit(req.user.displayName, `Permanently deleted member ${target.displayName} and all their activity history`, target.displayName);
  res.json({ ok: true });
});

app.post('/api/users/import', requireAuth, (req, res) => {
  const actor = req.user;
  if(actor.role !== 'admin'){
    res.status(403).json({ error: 'Only admins can import CSV files.' }); return;
  }
  const { csvText, confirm } = req.body || {};
  if(!csvText){ res.status(400).json({ error: 'No CSV text provided.' }); return; }

  let records;
  try{ records = parse(csvText, { columns: h => h.map(c=>c.toLowerCase().trim().replace(/\s+/g,'_')), skip_empty_lines: true }); }
  catch(e){ res.status(400).json({ error: 'Could not parse that CSV.' }); return; }

  if(!records.length || !('username' in records[0]) || !('display_name' in records[0])){
    res.status(400).json({ error: 'CSV needs "username" and "display_name" columns.' }); return;
  }

  const seen = new Set();
  const rows = records.map(r => {
    const rawUsername = r.username || '';
    const username = normalizeUsername(rawUsername);
    const displayName = r.display_name || rawUsername;
    const xUsername = normalizeUsername(r.x_username || '');
    const whatsapp = (r.whatsapp || '').replace(/\D/g,'');
    const password = (r.password || '').trim();
    const moderatorUsernameRaw = (r.moderator || '').trim();
    const pctRaw = r.assigned_percentage !== undefined && r.assigned_percentage !== '' ? Number(r.assigned_percentage) : 50;
    const monetizedRaw = (r.monetized || '').trim().toLowerCase();
    const monetized = monetizedRaw==='true' || monetizedRaw==='yes' || monetizedRaw==='1';

    let status = 'create', note = '', moderatorId = actor.role==='admin' ? null : actor.id;
    if(!username){ return { rawUsername, status:'error', note:'Missing username' }; }
    if(isNaN(pctRaw) || pctRaw < 10 || pctRaw > 100){ return { rawUsername, status:'error', note:'assigned_percentage must be 10\u2013100' }; }
    if(seen.has(username)){ status='error'; note='Duplicate username in file'; }
    else{
      const existing = getUserByUsername(username);
      if(existing && existing.role !== 'member'){ status='error'; note = `"${username}" already exists as ${existing.role}`; }
      else if(existing){
        status='update';
        if(actor.role !== 'admin' && existing.moderatorId !== actor.id){ status='error'; note='Not in your scope'; }
      }
      if(status !== 'error' && actor.role==='admin' && moderatorUsernameRaw){
        const mod = getUserByUsername(moderatorUsernameRaw);
        if(!mod || mod.role !== 'moderator') note = `Moderator "${moderatorUsernameRaw}" not found \u2014 left unassigned`;
        else moderatorId = mod.id;
      }
    }
    if(status !== 'error') seen.add(username);
    const existingUser = getUserByUsername(username);
    return { rawUsername, username, displayName, xUsername, whatsapp, password, moderatorId, assignedPercentage: clamp(pctRaw,10,100), monetized, status, note,
      existingId: (existingUser && existingUser.role==='member') ? existingUser.id : null };
  });

  if(!confirm){ res.json({ rows }); return; }

  let created = 0, updated = 0;
  rows.filter(r=>r.status!=='error').forEach(r => {
    if(r.status==='update' && r.existingId){
      const m = getUser(r.existingId);
      m.displayName = r.displayName; m.xUsername = r.xUsername; m.whatsapp = r.whatsapp; m.assignedPercentage = r.assignedPercentage; m.monetized = r.monetized;
      if(r.moderatorId !== null) m.moderatorId = r.moderatorId;
      if(r.password) m.passwordHash = bcrypt.hashSync(r.password, 10);
      updated++;
    }else{
      users.push({ id: uid('u'), username:r.username, passwordHash: bcrypt.hashSync(r.password || 'changeme123', 10),
        displayName:r.displayName, role:'member', status:'active', xUsername:r.xUsername, whatsapp:r.whatsapp,
        moderatorId:r.moderatorId, assignedPercentage:r.assignedPercentage, monetized:r.monetized, permissions:null, createdAt: Date.now() });
      created++;
    }
  });
  persistUsers();
  logAudit(actor.displayName, `Imported members via CSV: ${created} created, ${updated} updated`, '');
  res.json({ rows, created, updated });
});

/* ===== Daily activity ===== */

app.post('/api/activity', requireAuth, (req, res) => {
  const actor = req.user;
  const { userId, date, posts, manualPercentage, reason } = req.body || {};
  const target = getUser(userId);
  if(!target || target.role !== 'member'){ res.status(404).json({ error: 'Member not found.' }); return; }
  // Only admins set daily activity by hand \u2014 moderators can't, whatever permissions they were given.
  if(actor.role !== 'admin'){
    res.status(403).json({ error: 'Only admins can set daily activity.' }); return;
  }
  const postsVal = (posts===undefined||posts===null||posts==='') ? null : Math.max(0, parseInt(posts,10)||0);
  const manualVal = (manualPercentage===undefined||manualPercentage===null||manualPercentage==='') ? null : clamp(Number(manualPercentage),0,100);

  let rec = getRecord(userId, date);
  if(rec){
    rec.posts = postsVal; rec.manualPercentage = manualVal; rec.reason = reason || null;
    rec.source = 'manual'; rec.updatedBy = actor.displayName; rec.updatedAt = Date.now();
  }else{
    rec = { id: uid('a'), userId, date, posts: postsVal, manualPercentage: manualVal, reason: reason||null,
      source: 'manual', createdBy: actor.displayName, updatedBy: actor.displayName, createdAt: Date.now(), updatedAt: Date.now() };
    activity.push(rec);
  }
  persistActivity();
  logAudit(actor.displayName, `Set ${target.displayName}'s ${date} activity`, target.displayName);
  res.json({ record: rec });
});

app.post('/api/activity/import', requireAuth, (req, res) => {
  const actor = req.user;
  if(actor.role !== 'admin'){
    res.status(403).json({ error: 'Only admins can import CSV files.' }); return;
  }
  const { csvText, date, confirm } = req.body || {};
  if(!csvText || !date){ res.status(400).json({ error: 'CSV text and date are required.' }); return; }

  let records;
  try{ records = parse(csvText, { columns: h => h.map(c=>c.toLowerCase().trim().replace(/\s+/g,'_')), skip_empty_lines: true }); }
  catch(e){ res.status(400).json({ error: 'Could not parse that CSV.' }); return; }

  if(!records.length || !('username' in records[0]) || !('repost_percentage' in records[0])){
    res.status(400).json({ error: 'CSV needs "username" and "repost_percentage" columns.' }); return;
  }

  const scopeSet = new Set(scopeIdsFor(actor));
  const seen = new Set();
  const rows = records.map(r => {
    const rawUsername = r.username || '';
    const username = normalizeUsername(rawUsername);
    const pct = parseFloat(r.repost_percentage);
    const posts = r.total_posts !== undefined && r.total_posts !== '' ? parseInt(r.total_posts,10) : null;
    const user = getUserByUsername(username);

    let status = 'ok', note = '';
    if(isNaN(pct) || pct<0 || pct>100) { status='error'; note='Invalid repost_percentage value'; }
    else if(!user || user.role!=='member'){ status='notfound'; note='Member not found'; }
    else if(!scopeSet.has(user.id)){ status='error'; note='Not in your scope'; }
    else if(seen.has(username)){ status='duplicate'; note='Duplicate username in file'; }
    if(status==='ok') seen.add(username);
    return { rawUsername, username, pct: isNaN(pct)?null:Math.round(pct*10)/10, posts: (posts!==null && !isNaN(posts) && posts>=0) ? posts : null, status, note, userId: user?user.id:null };
  });

  if(!confirm){ res.json({ rows }); return; }

  let count = 0;
  rows.filter(r=>r.status==='ok').forEach(r => {
    let rec = getRecord(r.userId, date);
    if(rec){
      rec.posts = r.posts; rec.manualPercentage = r.pct; rec.reason = 'CSV import (repost_percentage)';
      rec.source = 'csv'; rec.updatedBy = actor.displayName; rec.updatedAt = Date.now();
    }else{
      rec = { id: uid('a'), userId: r.userId, date, posts: r.posts, manualPercentage: r.pct, reason: 'CSV import (repost_percentage)',
        source: 'csv', createdBy: actor.displayName, updatedBy: actor.displayName, createdAt: Date.now(), updatedAt: Date.now() };
      activity.push(rec);
    }
    count++;
  });
  persistActivity();
  logAudit(actor.displayName, `Imported CSV for ${date}: ${count} records (repost_percentage column)`, '');
  res.json({ rows, count });
});

/* ===== Settings ===== */

/* ===== Payouts (weekly Premium awards + any other recorded payout) ===== */

const PREMIUM_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function payoutWithUser(p){
  if(p.type === 'community') return Object.assign({}, p, { displayName: 'Community fund', username: '' });
  const u = getUser(p.userId);
  return Object.assign({}, p, { displayName: u?u.displayName:'(deleted member)', username: u?u.username:'' });
}
function payoutTargetName(p){
  if(p.type === 'community') return 'Community fund';
  const u = getUser(p.userId);
  return u ? u.displayName : '(deleted member)';
}

app.get('/api/payouts', requireAuth, (req, res) => {
  const viewer = req.user;
  const communityTotal = payouts.reduce((s,p)=>s+(p.amount||0), 0);
  const premiumPayouts = payouts.filter(p=>p.type==='premium').sort((a,b)=> b.date < a.date ? -1 : 1);
  let lastPremiumWinner = premiumPayouts.length ? payoutWithUser(premiumPayouts[0]) : null;
  // Members only ever see their own payout amounts — for someone else's win, just the name + date.
  if(lastPremiumWinner && viewer.role==='member' && lastPremiumWinner.userId!==viewer.id){
    lastPremiumWinner = { userId: lastPremiumWinner.userId, displayName: lastPremiumWinner.displayName, date: lastPremiumWinner.date };
  }

  const mine = payouts.filter(p=>p.userId===viewer.id).sort((a,b)=> b.date < a.date ? -1 : 1);
  const myTotal = mine.reduce((s,p)=>s+(p.amount||0), 0);
  const myRecent = mine.slice(0,5).map(payoutWithUser);

  let scoped;
  if(viewer.role==='admin') scoped = payouts;
  else if(viewer.role==='moderator'){
    const scopeSet = new Set(scopeIdsFor(viewer).concat([viewer.id]));
    scoped = payouts.filter(p=>scopeSet.has(p.userId));
  }else{
    scoped = mine;
  }
  scoped = scoped.slice().sort((a,b)=> b.date < a.date ? -1 : 1).map(payoutWithUser);

  res.json({ communityTotal, lastPremiumWinner, myTotal, myRecent, scoped });
});

app.post('/api/payouts', requireAuth, requireAdmin, (req, res) => {
  const actor = req.user;
  const { userId, amount, monetized, type, note, date, override } = req.body || {};
  const target = getUser(userId);
  if(!target || target.role !== 'member'){ res.status(400).json({ error: 'Member not found.' }); return; }
  const payDate = date || dateStr(0);
  const payType = type || 'premium';
  if(payType === 'community'){ res.status(400).json({ error: 'Use "Add Funds" for community fund entries.' }); return; }
  const payAmount = Number(amount) || 0;

  if(payType === 'premium' && !override){
    const priorPremiums = payouts.filter(p=>p.userId===userId && p.type==='premium');
    if(priorPremiums.length){
      const mostRecent = priorPremiums.reduce((a,b)=> a.date > b.date ? a : b);
      const gapMs = new Date(payDate) - new Date(mostRecent.date);
      if(gapMs < PREMIUM_COOLDOWN_MS){
        const eligibleOn = new Date(new Date(mostRecent.date).getTime() + PREMIUM_COOLDOWN_MS).toISOString().slice(0,10);
        res.status(409).json({ error: 'cooldown_active', eligibleOn, lastAwardedOn: mostRecent.date });
        return;
      }
    }
  }

  const payout = { id: uid('pay'), userId, date: payDate, amount: payAmount, monetized: !!monetized, type: payType, note: note||'', awardedBy: actor.displayName, createdAt: Date.now() };
  payouts.push(payout);
  persistPayouts();
  logAudit(actor.displayName, `Awarded ${payType}${payAmount?` ($${payAmount})`:''} to ${target.displayName}${note?` \u2014 ${note}`:''}`, target.displayName);
  res.json({ payout: payoutWithUser(payout) });
});

// Manual top-up of the community total — not tied to any member, so it never shows
// up in anyone's personal payout history, only in the community total.
app.post('/api/funds', requireAuth, requireAdmin, (req, res) => {
  const actor = req.user;
  const { amount, note, date } = req.body || {};
  const payAmount = Number(amount);
  if(!payAmount || isNaN(payAmount)){ res.status(400).json({ error: 'Enter a non-zero amount.' }); return; }
  const fund = { id: uid('pay'), userId: '', date: date || dateStr(0), amount: payAmount, monetized: true, type: 'community', note: note||'', awardedBy: actor.displayName, createdAt: Date.now() };
  payouts.push(fund);
  persistPayouts();
  logAudit(actor.displayName, `Added $${payAmount} to community funds${note?` — ${note}`:''}`, '');
  res.json({ payout: payoutWithUser(fund) });
});

app.put('/api/payouts/:id', requireAuth, requireAdmin, (req, res) => {
  const actor = req.user;
  const payout = payouts.find(p=>p.id===req.params.id);
  if(!payout){ res.status(404).json({ error: 'Payout not found.' }); return; }
  const { amount, monetized, type, note, date } = req.body || {};
  const before = { amount: payout.amount, type: payout.type };
  if(amount !== undefined) payout.amount = Number(amount) || 0;
  if(monetized !== undefined) payout.monetized = !!monetized;
  // A community-fund entry has no member, so it can't turn into a member payout (or vice versa).
  if(type !== undefined && payout.type !== 'community' && type !== 'community') payout.type = type || payout.type;
  if(note !== undefined) payout.note = note;
  if(date !== undefined) payout.date = date;
  persistPayouts();
  const targetName = payoutTargetName(payout);
  logAudit(actor.displayName, `Edited a payout for ${targetName}: ${before.type} $${before.amount} \u2192 ${payout.type} $${payout.amount}`, targetName);
  res.json({ payout: payoutWithUser(payout) });
});

app.delete('/api/payouts/:id', requireAuth, requireAdmin, (req, res) => {
  const actor = req.user;
  const payout = payouts.find(p=>p.id===req.params.id);
  if(!payout){ res.status(404).json({ error: 'Payout not found.' }); return; }
  const targetName = payoutTargetName(payout);
  payouts = payouts.filter(p=>p.id!==req.params.id);
  persistPayouts();
  logAudit(actor.displayName, `Deleted a payout (${payout.type}, $${payout.amount}) for ${targetName}`, targetName);
  res.json({ ok: true });
});

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const { communityName, timezone } = req.body || {};
  if(communityName !== undefined) settings.communityName = communityName.trim() || 'My Community';
  if(timezone !== undefined) settings.timezone = timezone.trim() || 'Asia/Karachi';
  persistSettings();
  logAudit(req.user.displayName, 'Updated community settings', '');
  res.json({ settings });
});

/* ===== Static frontend ===== */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if(req.path.startsWith('/api/')){ res.status(404).json({ error: 'Not found' }); return; }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Bitbase server running at http://localhost:${PORT}`);
  console.log(`Data files stored in: ${DATA_DIR}`);
});

module.exports = app;
