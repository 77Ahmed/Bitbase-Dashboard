/* ===================== Bitbase — App logic (part 1: state & calc) ===================== */
'use strict';

const THEME_KEY = 'bitbase_theme'; // per-browser UI preference only — not account data

function dateStr(offsetDays){
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0,10);
}
function fmtDate(iso){
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}
function fmtDateShort(iso){
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
}
function fmtDateTime(ts){
  const d = new Date(ts);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ', ' + d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
}
function last7Dates(endOffset){
  const arr = [];
  for(let i=6;i>=0;i--) arr.push(dateStr((endOffset||0)-i));
  return arr;
}
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
function initials(name){
  return (name||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
}
function normalizeUsername(u){
  return (u||'').trim().toLowerCase().replace(/^@/, '');
}
function uid(prefix){
  return prefix + '_' + Math.random().toString(36).slice(2,9);
}
function fmtPct(n){
  if(n === null || n === undefined) return '\u2014';
  const r = Math.round(n*10)/10;
  return (Number.isInteger(r) ? r : r.toFixed(1)) + '%';
}

/* ---------------- Actual-vs-assigned status color ----------------
   green  = met or beat their assigned target
   orange = below target, but within 15 points of it
   red    = more than 15 points below target
   (Tune ORANGE_BAND below if you want a different cutoff.) */
const ORANGE_BAND = 15;
function activityStatus(actualPct, assignedPct){
  if(actualPct === null || actualPct === undefined || assignedPct === null || assignedPct === undefined) return null;
  if(actualPct >= assignedPct) return 'green';
  if(actualPct >= assignedPct - ORANGE_BAND) return 'orange';
  return 'red';
}
function statusDot(status){
  if(!status) return '';
  return `<span class="status-dot ${status}" title="${status==='green'?'On target':status==='orange'?'Below target':'Well below target'}"></span>`;
}
function monetizedBadge(isMonetized){
  if(!isMonetized) return '';
  return `<span class="monetized-dot" title="Monetized"></span>`;
}
function pctVsAssignedHtml(actualPct, assignedPct){
  const status = activityStatus(actualPct, assignedPct);
  return `<span class="pct-vs">${fmtPct(actualPct)}<span class="assigned"> / ${fmtPct(assignedPct)} assigned</span></span>`;
}
function coloredBarHtml(actualPct, assignedPct, width){
  const status = activityStatus(actualPct, assignedPct);
  const w = actualPct===null||actualPct===undefined ? 0 : actualPct;
  const cssWidth = typeof width === 'string' ? width : (width||80) + 'px';
  return `<div class="pbar ${status||''}" style="display:inline-block;width:${cssWidth};vertical-align:middle;"><span style="width:${clamp(w,0,100)}%"></span></div>`;
}

/* ---------------- API client (talks to the Node/CSV backend) ---------------- */
const API = '/api';

async function apiGet(pathSuffix){
  const res = await fetch(API + pathSuffix, { credentials: 'include' });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}
async function apiSend(method, pathSuffix, body){
  const res = await fetch(API + pathSuffix, {
    method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok){ const err = new Error(data.error || ('Request failed (' + res.status + ')')); err.data = data; throw err; }
  return data;
}

/* ---------------- Fresh client-side state, populated from the server ----------------
   Percentage model: each member's daily % is either their share of that day's
   TOTAL community posts (posts / dailyCommunityTotal * 100), a directly
   assigned percentage, or a repost_percentage imported from CSV. */
function emptyState(){
  return {
    users: [],
    dailyActivity: [],
    auditLogs: [],
    directory: [],
    payouts: { communityTotal: 0, lastPremiumWinner: null, myTotal: 0, myRecent: [], scoped: [] },
    settings: { communityName: '', timezone: 'Asia/Karachi' },
    session: { currentUserId: null },
    hasAdminFlag: false,
    ui: { view: 'dashboard', params: {}, mobileNavOpen: false }
  };
}

var state = emptyState();

// Pulls the latest scoped data from the server into the client `state` object,
// without touching state.ui (current view/tab/params stay put across refreshes).
async function fetchState(){
  const data = await apiGet('/state');
  state.users = data.users || [];
  state.dailyActivity = data.dailyActivity || [];
  state.auditLogs = data.auditLogs || [];
  state.directory = data.directory || [];
  state.settings = data.settings || state.settings;
  state.session = data.session || { currentUserId: null };
  state.hasAdminFlag = !!data.hasAdmin;
  if(data.authenticated) await fetchPayouts();
}
async function fetchPayouts(){
  try{ state.payouts = await apiGet('/payouts'); }
  catch(e){ /* non-fatal — payouts widgets just show zeros if this fails */ }
}
function hasAdmin(){ return state.hasAdminFlag; }
function saveState(){ /* no-op: the server is the source of truth now */ }

/* ---------------- Core lookups ---------------- */
function getUser(id){ return state.users.find(u => u.id === id); }
function getUserByUsername(username){
  const n = normalizeUsername(username);
  return state.users.find(u => normalizeUsername(u.username) === n);
}
function currentUser(){ return state.session.currentUserId ? getUser(state.session.currentUserId) : null; }

function membersOf(moderatorId){
  return state.users.filter(u => u.role === 'member' && u.moderatorId === moderatorId);
}
function allMembers(){ return state.users.filter(u => u.role === 'member'); }
function allModerators(){ return state.users.filter(u => u.role === 'moderator'); }

// scope = array of visible member user ids for the current viewer (who they can manage/see)
function scopeForCurrentUser(){
  const u = currentUser();
  if(!u) return [];
  if(u.role === 'admin') return allMembers().map(m=>m.id);
  if(u.role === 'moderator') return membersOf(u.id).map(m=>m.id);
  if(u.role === 'member') return [u.id];
  return [];
}

function canModeratorAct(perm){
  const u = currentUser();
  if(!u) return false;
  if(u.role === 'admin') return true;
  if(u.role === 'moderator') return !!(u.permissions && u.permissions[perm]);
  return false;
}

/* ---------------- Daily activity: community-share percentage model ---------------- */
function getRecord(userId, date){
  return state.dailyActivity.find(r => r.userId === userId && r.date === date) || null;
}
function getRecordsForUser(userId){
  return state.dailyActivity.filter(r => r.userId === userId).sort((a,b)=> a.date < b.date ? 1 : -1);
}

// Total posts made by the whole active community on a given day.
// Records with a manual percentage (posts unknown/not counted) are excluded from the pool.
function dailyCommunityTotal(date){
  let total = 0;
  state.dailyActivity.forEach(r => {
    if(r.date !== date) return;
    if(r.posts === null || r.posts === undefined) return;
    const u = getUser(r.userId);
    if(!u || u.status !== 'active') return;
    total += r.posts;
  });
  return total;
}

// A member's raw share of that day's community total, before any manual override.
function poolPercentage(rec){
  if(!rec || rec.posts === null || rec.posts === undefined) return null;
  const total = dailyCommunityTotal(rec.date);
  if(total <= 0) return 0;
  return Math.round((rec.posts / total) * 1000) / 10;
}

// The percentage actually shown/ranked on: manual override if set, else pool share.
function effectivePercentage(rec){
  if(!rec) return null;
  if(rec.manualPercentage !== null && rec.manualPercentage !== undefined) return rec.manualPercentage;
  const p = poolPercentage(rec);
  return p === null ? 0 : p;
}

function weeklyStats(userId, endOffset){
  const days = last7Dates(endOffset||0);
  const member = getUser(userId);
  const assignedPct = member ? member.assignedPercentage : 50;
  let achievedDays = 0, daysReported = 0;
  const breakdown = days.map(date => {
    const rec = getRecord(userId, date);
    let pct = null, achieved = false;
    if(rec){
      daysReported++;
      pct = effectivePercentage(rec);
      achieved = pct >= assignedPct;
      if(achieved) achievedDays++;
    }
    return { date, record: rec, pct, achieved };
  });
  // Out of the full 7-day week (not just days reported) — a missing day, like a
  // 0% day, simply isn't a day the target was hit. Meet the target all 7 days -> 100%.
  const weeklyPct = Math.round((achievedDays/7)*1000)/10;
  return { breakdown, achievedDays, daysReported, weeklyPct, assignedPct };
}

/* ---------------- Leaderboard ---------------- */
function dailyRanking(date, scopeIds){
  const ids = scopeIds || allMembers().map(m=>m.id);
  const rows = ids.map(id => {
    const u = getUser(id);
    if(!u || u.status !== 'active') return null;
    const rec = getRecord(id, date);
    if(!rec) return null;
    return { userId:id, user:u, pct: effectivePercentage(rec), posts: rec.posts, record: rec };
  }).filter(Boolean);
  rows.sort((a,b)=> b.pct - a.pct || (b.posts||0) - (a.posts||0) || a.user.displayName.localeCompare(b.user.displayName));
  rows.forEach((r,i)=>{ r.rank = i+1; r.medal = i===0?'gold':i===1?'silver':i===2?'bronze':null; });
  return rows;
}

function weeklyLeaderboard(scopeIds, endOffset){
  const ids = scopeIds || allMembers().map(m=>m.id);
  const days = last7Dates(endOffset||0);
  const points = {}; ids.forEach(id => points[id] = { userId:id, goldDays:0, silverDays:0, bronzeDays:0, points:0 });
  days.forEach(date => {
    const ranking = dailyRanking(date, ids);
    ranking.forEach(r => {
      if(r.medal === 'gold'){ points[r.userId].goldDays++; points[r.userId].points += 1; }
      if(r.medal === 'silver') points[r.userId].silverDays++;
      if(r.medal === 'bronze') points[r.userId].bronzeDays++;
    });
  });
  const rows = ids.map(id => {
    const u = getUser(id);
    if(!u) return null;
    const ws = weeklyStats(id, endOffset);
    return { userId:id, user:u, points: points[id].points, goldDays: points[id].goldDays, silverDays: points[id].silverDays, bronzeDays: points[id].bronzeDays, weeklyPct: ws.weeklyPct };
  }).filter(Boolean);
  rows.sort((a,b)=> b.points - a.points || b.weeklyPct - a.weeklyPct || a.user.displayName.localeCompare(b.user.displayName));
  rows.forEach((r,i)=>{ r.rank = i+1; r.medal = i===0?'gold':i===1?'silver':i===2?'bronze':null; });
  return rows;
}

/* Audit logging now happens server-side on every write — see server.js logAudit(). */

/* ===================== Part 2: UI shell, toast, modal, router ===================== */

function toast(msg, isErr){
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(()=> el.remove(), 3200);
}

function closeModal(){
  const el = document.getElementById('modalRoot');
  el.innerHTML = '';
}
function openModal(html){
  const el = document.getElementById('modalRoot');
  el.innerHTML = `<div class="overlay" onmousedown="if(event.target===this) closeModal()">${html}</div>`;
}

// Members can only open their own detail page (weekly breakdown + payouts);
// admins and moderators can open anyone's.
function canViewMemberDetail(memberId){
  const u = currentUser();
  return !!u && (u.role !== 'member' || u.id === memberId);
}
// Attributes that make a member's name open their detail page — or nothing, if the viewer can't open it.
function memberLinkAttrs(memberId){
  return canViewMemberDetail(memberId) ? ` data-link onclick="goto('memberDetail',{userId:'${memberId}'})"` : '';
}

function goto(view, params){
  if(view === 'memberDetail' && !canViewMemberDetail(params && params.userId)){
    toast('You can only view your own weekly report and payouts.', true);
    return;
  }
  state.ui.view = view;
  state.ui.params = params || {};
  state.ui.mobileNavOpen = false;
  render();
}

function requireConfirm(btnEl, label, action){
  if(btnEl.dataset.confirming === '1'){
    action();
  }else{
    btnEl.dataset.confirming = '1';
    const old = btnEl.textContent;
    btnEl.textContent = 'Confirm ' + label + '?';
    btnEl.classList.add('btn-danger');
    setTimeout(()=>{ btnEl.dataset.confirming='0'; btnEl.textContent = old; }, 3000);
  }
}

/* ---------------- Nav config ---------------- */
function navFor(role){
  if(role === 'admin') return [
    {v:'dashboard', l:'Dashboard', i:'\u2601\ufe0f'},
    {v:'members', l:'Members', i:'\ud83d\udc65'},
    {v:'moderators', l:'Moderators', i:'\ud83d\udee1\ufe0f'},
    {v:'daily', l:'Daily Reports', i:'\ud83d\udcc5'},
    {v:'weekly', l:'Weekly Reports', i:'\ud83d\udcc8'},
    {v:'imports', l:'Imports (CSV)', i:'\u2b06\ufe0f'},
    {v:'leaderboard', l:'Leaderboard', i:'\ud83c\udfc6'},
    {v:'directory', l:'All Members', i:'\ud83c\udf10'},
    {v:'audit', l:'Audit Logs', i:'\ud83d\udcdc'},
    {v:'payouts', l:'Payouts', i:'\ud83d\udcb0'},
    {v:'settings', l:'Settings', i:'\u2699\ufe0f'},
  ];
  if(role === 'moderator') return [
    {v:'dashboard', l:'Dashboard', i:'\u2601\ufe0f'},
    {v:'members', l:'My Members', i:'\ud83d\udc65'},
    {v:'daily', l:'Daily Reports', i:'\ud83d\udcc5'},
    {v:'weekly', l:'Weekly Reports', i:'\ud83d\udcc8'},
    {v:'imports', l:'Imports (CSV)', i:'\u2b06\ufe0f'},
    {v:'leaderboard', l:'Leaderboard', i:'\ud83c\udfc6'},
    {v:'directory', l:'All Members', i:'\ud83c\udf10'},
    {v:'audit', l:'Activity History', i:'\ud83d\udcdc'},
  ];
  return [
    {v:'dashboard', l:'Dashboard', i:'\u2601\ufe0f'},
    {v:'profile', l:'My Profile', i:'\ud83d\udc64'},
    {v:'daily', l:'Daily Reports', i:'\ud83d\udcc5'},
    {v:'weekly', l:'My Weekly Activity', i:'\ud83d\udcc8'},
    {v:'leaderboard', l:'Leaderboard', i:'\ud83c\udfc6'},
    {v:'directory', l:'All Members', i:'\ud83c\udf10'},
  ];
}

/* ---------------- Root render ---------------- */
function render(){
  const root = document.getElementById('root');
  if(!hasAdmin()){
    root.innerHTML = renderSetup();
    return;
  }
  const u = currentUser();
  if(!u){
    root.innerHTML = renderLogin();
    return;
  }
  const nav = navFor(u.role);
  const detailViews = ['memberDetail', 'moderators', 'settings'];
  const activeView = (nav.find(n=>n.v===state.ui.view) || detailViews.includes(state.ui.view)) ? state.ui.view : 'dashboard';
  state.ui.view = activeView;

  root.innerHTML = `
    <div class="app-shell ${state.ui.mobileNavOpen?'mobile-nav-open':''}" onclick="if(state.ui.mobileNavOpen && !event.target.closest('.sidebar') && !event.target.closest('.burger')){ state.ui.mobileNavOpen=false; render(); }">
      <aside class="sidebar">
        <div class="brand">Bitbase<span class="brand-tag">community</span><button class="drawer-close" aria-label="Close menu" onclick="state.ui.mobileNavOpen=false; render();">✕</button></div>
        <nav>
          ${nav.map(n=>`<a class="nav-item ${n.v===activeView?'active':''}" onclick="goto('${n.v}')"><span class="ic">${n.i}</span>${n.l}</a>`).join('')}
        </nav>
        <div class="sidebar-foot">
          <div class="who">
            <div class="avatar">${initials(u.displayName)}</div>
            <div class="meta"><div class="n">${escapeHtml(u.displayName)}</div><div class="r">${u.role}</div></div>
          </div>
          <a class="nav-item" onclick="logout()"><span class="ic">\ud83d\udeaa</span>Logout</a>
        </div>
      </aside>
      <div class="main">
        <div class="topbar">
          <button class="burger" aria-label="Open menu" onclick="event.stopPropagation(); state.ui.mobileNavOpen=!state.ui.mobileNavOpen; render();">\u2630</button>
          <div class="topbar-title">${escapeHtml((nav.find(n=>n.v===activeView)||{l:activeView==='memberDetail'?'Member Details':'Bitbase'}).l)}</div>
          <div class="avatar" title="${escapeHtml(u.displayName)}">${initials(u.displayName)}</div>
        </div>
        <div class="content">
          ${renderView(activeView, u)}
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(s){
  return (s===undefined||s===null?'':String(s)).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function logout(){
  try{ await apiSend('POST', '/logout'); }catch(e){ /* ignore — we're logging out regardless */ }
  await fetchState();
  render();
}

/* ===================== Part 3: Setup & Login ===================== */

function renderSetup(){
  return `
  <div class="login-screen">
    <div class="cloud-blob" style="width:220px;height:120px;top:8%;left:8%;"></div>
    <div class="cloud-blob" style="width:160px;height:90px;top:65%;left:78%;animation-delay:-8s;"></div>
    <div class="cloud-blob" style="width:130px;height:80px;top:20%;left:70%;animation-delay:-14s;"></div>
    <div class="login-card">
      <div class="login-brand"><span class="name">Bitbase<span class="brand-tag">community</span></span></div>
      <div class="login-sub">Let's set up your community \u2014 this creates your Admin account</div>
      <div id="setupErrorBox"></div>
      <form onsubmit="return doSetup(event)">
        <div class="field">
          <label>Community name</label>
          <input id="setupCommunity" type="text" placeholder="e.g. Simply Cloudy" required />
        </div>
        <div class="field">
          <label>Your display name</label>
          <input id="setupDisplayName" type="text" placeholder="e.g. Alex Khan" required />
        </div>
        <div class="field">
          <label>Admin username</label>
          <input id="setupUsername" type="text" autocomplete="username" placeholder="e.g. admin" required />
        </div>
        <div class="field">
          <label>Password</label>
          <input id="setupPassword" type="password" autocomplete="new-password" placeholder="Choose a password" required minlength="6" />
        </div>
        <div class="field">
          <label>Confirm password</label>
          <input id="setupPassword2" type="password" autocomplete="new-password" placeholder="Re-type the password" required minlength="6" />
        </div>
        <button class="btn btn-primary" type="submit">Create Admin account</button>
      </form>
      <div class="demo-box">
        <div>You'll add moderators and members after logging in \u2014 one at a time, or in bulk via CSV import.</div>
      </div>
    </div>
  </div>`;
}

async function doSetup(e){
  e.preventDefault();
  const box = document.getElementById('setupErrorBox');
  const communityName = document.getElementById('setupCommunity').value.trim();
  const displayName = document.getElementById('setupDisplayName').value.trim();
  const username = normalizeUsername(document.getElementById('setupUsername').value);
  const password = document.getElementById('setupPassword').value;
  const password2 = document.getElementById('setupPassword2').value;

  if(!username){ box.innerHTML = `<div class="login-error">Please enter a username.</div>`; return false; }
  if(password.length < 6){ box.innerHTML = `<div class="login-error">Password must be at least 6 characters.</div>`; return false; }
  if(password !== password2){ box.innerHTML = `<div class="login-error">Passwords don't match.</div>`; return false; }

  try{
    await apiSend('POST', '/setup', { communityName, displayName, username, password });
    await fetchState();
    state.ui.view = 'dashboard';
    render();
  }catch(err){
    box.innerHTML = `<div class="login-error">${escapeHtml(err.message)}</div>`;
  }
  return false;
}

function renderLogin(){
  return `
  <div class="login-screen">
    <div class="cloud-blob" style="width:220px;height:120px;top:8%;left:8%;"></div>
    <div class="cloud-blob" style="width:160px;height:90px;top:65%;left:78%;animation-delay:-8s;"></div>
    <div class="cloud-blob" style="width:130px;height:80px;top:20%;left:70%;animation-delay:-14s;"></div>
    <div class="login-card">
      <div class="login-brand"><span class="name">Bitbase<span class="brand-tag">community</span></span></div>
      <div class="login-sub">Welcome back to ${escapeHtml(state.settings.communityName || 'Bitbase')}</div>
      <div id="loginErrorBox"></div>
      <form onsubmit="return doLogin(event)">
        <div class="field">
          <label>Username</label>
          <input id="loginUsername" type="text" autocomplete="username" placeholder="Your username" required />
        </div>
        <div class="field">
          <label>Password</label>
          <input id="loginPassword" type="password" autocomplete="current-password" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" required />
        </div>
        <button class="btn btn-primary" type="submit">Log in</button>
      </form>
    </div>
  </div>`;
}

async function doLogin(e){
  e.preventDefault();
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  const box = document.getElementById('loginErrorBox');
  try{
    await apiSend('POST', '/login', { username, password });
    await fetchState();
    state.ui.view = 'dashboard';
    render();
  }catch(err){
    box.innerHTML = `<div class="login-error">${escapeHtml(err.message)}</div>`;
  }
  return false;
}

/* ===================== View router ===================== */
function renderView(view, u){
  try{
    switch(view){
      case 'dashboard': return u.role==='member' ? renderMemberDashboard(u) : renderRoleDashboard(u);
      case 'members': return renderMembersList(u);
      case 'moderators': return renderModeratorsList(u);
      case 'daily': return renderDailyReports(u);
      case 'weekly': return u.role==='member' ? renderMemberWeekly(u) : renderWeeklyReports(u);
      case 'imports': return renderImports(u);
      case 'leaderboard': return renderLeaderboard(u);
      case 'directory': return renderDirectory(u);
      case 'audit': return renderAuditLog(u);
      case 'settings': return renderSettings(u);
      case 'payouts': return renderPayoutsPage(u);
      case 'profile': return renderMemberProfile(u);
      case 'memberDetail': return renderMemberDetail(u, state.ui.params.userId);
      default: return renderRoleDashboard(u);
    }
  }catch(err){
    console.error(err);
    return `<div class="empty"><div class="big">\u26a0\ufe0f</div><div>Something went wrong rendering this page.</div></div>`;
  }
}

/* ===================== Part 4: Dashboards ===================== */

function medalHtml(medal){
  if(medal==='gold') return '<span class="medal">\ud83e\udd47</span>';
  if(medal==='silver') return '<span class="medal">\ud83e\udd48</span>';
  if(medal==='bronze') return '<span class="medal">\ud83e\udd49</span>';
  return '';
}

function activitySourceTag(rec){
  if(!rec) return '';
  const hasManual = rec.manualPercentage !== null && rec.manualPercentage !== undefined;
  const postsNote = rec.posts !== null && rec.posts !== undefined ? `${rec.posts} posts` : '';
  if(rec.source === 'csv') return `<span class="muted" style="font-size:11px;">(CSV${postsNote?' \u00b7 '+postsNote:''})</span>`;
  if(hasManual) return `<span class="muted" style="font-size:11px;">(manual${postsNote?' \u00b7 '+postsNote:''})</span>`;
  return postsNote ? `<span class="muted" style="font-size:11px;">(${postsNote})</span>` : '';
}

function renderRoleDashboard(u){
  const scope = scopeForCurrentUser();
  const today = dateStr(0);
  const todayRanking = dailyRanking(today, scope);
  const communityTotalToday = dailyCommunityTotal(today);
  const wLb = weeklyLeaderboard(scope);
  const weeklyAvg = wLb.length ? Math.round(wLb.reduce((s,r)=>s+r.weeklyPct,0)/wLb.length*10)/10 : 0;
  const activeCount = scope.map(getUser).filter(m=>m && m.status==='active').length;
  const missingToday = scope.filter(id => { const m=getUser(id); return m && m.status==='active' && !getRecord(id, today); });
  const py = state.payouts;

  const isAdmin = u.role === 'admin';
  const statCards = isAdmin ? `
    <div class="stat-card"><div class="label">Total Members</div><div class="value">${allMembers().length}</div></div>
    <div class="stat-card"><div class="label">Moderators</div><div class="value">${allModerators().length}</div></div>
    <div class="stat-card"><div class="label">Active Members</div><div class="value">${activeCount}</div></div>
    <div class="stat-card"><div class="label">Today's Community Posts</div><div class="value">${communityTotalToday}</div></div>
    <div class="stat-card"><div class="label">Weekly Avg %</div><div class="value blue">${fmtPct(weeklyAvg)}</div></div>
  ` : `
    <div class="stat-card"><div class="label">My Members</div><div class="value">${scope.length}</div></div>
    <div class="stat-card"><div class="label">Today's Community Posts</div><div class="value">${communityTotalToday}</div></div>
    <div class="stat-card"><div class="label">Weekly Avg %</div><div class="value blue">${fmtPct(weeklyAvg)}</div></div>
    <div class="stat-card"><div class="label">Missing Today</div><div class="value" style="color:${missingToday.length?'var(--danger)':'var(--success)'}">${missingToday.length}</div></div>
  `;

  const topRows = wLb.slice(0,5);
  const recentLogs = state.auditLogs.slice(0,6);

  return `
    <div class="page-head">
      <div><h1>Welcome, ${escapeHtml(u.displayName)} \ud83d\udc4b</h1><div class="sub">${escapeHtml(state.settings.communityName)} \u00b7 ${fmtDate(today)}</div></div>
    </div>
    <div class="grid-stats">${statCards}</div>

    <div class="grid-stats">
      ${communityTotalCardHtml(py, isAdmin)}
      <div class="stat-card">
        <div class="label">Last Premium Winner</div>
        ${py.lastPremiumWinner ? `<div class="value" style="font-size:16px;margin-top:6px;"${memberLinkAttrs(py.lastPremiumWinner.userId)}>\ud83c\udf1f ${escapeHtml(py.lastPremiumWinner.displayName)}</div><div class="muted" style="font-size:11.5px;">${fmtDate(py.lastPremiumWinner.date)}</div>` : `<div class="muted" style="margin-top:8px;">None yet</div>`}
      </div>
      ${isAdmin?`<div class="stat-card" style="display:flex;align-items:center;justify-content:center;"><button class="btn btn-primary" style="width:auto;" onclick="goto('leaderboard')">\ud83c\udf1f Award Weekly Premium</button></div>`:''}
    </div>

    ${missingToday.length ? `<div class="card" style="border-color:var(--danger);">
      <h3 style="color:var(--danger)">\u26a0\ufe0f ${missingToday.length} member${missingToday.length>1?'s':''} missing today's report</h3>
      <div class="muted" style="font-size:13px;">${missingToday.map(id=>escapeHtml(getUser(id).displayName)).join(', ')}</div>
    </div>` : ''}

    <div class="card">
      <div class="card-head"><h3>\ud83c\udfc6 Top of the Week</h3><button class="btn btn-ghost btn-sm" onclick="goto('leaderboard')">View full leaderboard \u2192</button></div>
      ${topRows.length ? `<div class="scrollx"><table><thead><tr><th>Rank</th><th>Member</th><th>Weekly %</th><th>Gold days</th></tr></thead><tbody>
        ${topRows.map(r=>{
          const todayRec = getRecord(r.userId, today);
          const st = todayRec ? activityStatus(effectivePercentage(todayRec), r.user.assignedPercentage) : null;
          return `<tr>
          <td>${medalHtml(r.medal)} #${r.rank}</td>
          <td><div class="cell-user"${memberLinkAttrs(r.userId)}>${statusDot(st)}<div class="mini-avatar">${initials(r.user.displayName)}</div>${escapeHtml(r.user.displayName)}${monetizedBadge(r.user.monetized)}</div></td>
          <td>${fmtPct(r.weeklyPct)}</td>
          <td>${r.goldDays}</td>
        </tr>`;
        }).join('')}
      </tbody></table></div>` : `<div class="empty">No activity recorded yet this week.</div>`}
    </div>

    <div class="card">
      <div class="card-head"><h3>Recent Activity</h3>${u.role==='admin'?`<button class="btn btn-ghost btn-sm" onclick="goto('audit')">Full log \u2192</button>`:''}</div>
      ${recentLogs.length ? recentLogs.map(l=>`
        <div class="history-item"><div class="dot"></div><div><div>${escapeHtml(l.action)}</div><div class="t">${escapeHtml(l.actor)} \u00b7 ${fmtDateTime(l.time)}</div></div></div>
      `).join('') : `<div class="empty">Nothing yet.</div>`}
    </div>
  `;
}

function communityTotalCardHtml(py, canAddFunds){
  return `<div class="stat-card">
    <div class="label">Community Total Payout</div>
    <div class="value blue">$${(py.communityTotal||0).toFixed(2)}</div>
    ${canAddFunds?`<button class="btn btn-outline btn-sm" style="margin-top:10px;" onclick="openFundModal()">+ Add Funds</button>`:''}
  </div>`;
}

function payoutsCardHtml(title, total, recentList, opts){
  opts = opts || {};
  return `<div class="card"${opts.maxWidth?` style="max-width:${opts.maxWidth}px;"`:''}>
    <h3>${title}</h3>
    <div style="font-size:26px;font-weight:700;color:var(--sky-deep);margin-bottom:10px;">$${(total||0).toFixed(2)}</div>
    ${recentList && recentList.length ? recentList.map(p=>`<div class="payout-row">
        <div><div style="font-weight:600;">${payoutTypeLabel(p.type)}${opts.showWho?` \u2014 ${escapeHtml(p.displayName||'')}`:''}</div><div class="muted" style="font-size:11.5px;">${fmtDate(p.date)}${p.note?' \u00b7 '+escapeHtml(p.note):''}</div></div>
        <div style="text-align:right;"><div class="amt">$${(p.amount||0).toFixed(2)}</div><span class="badge ${p.monetized?'monetized':'nonmonetized'}" style="margin-top:4px;">${p.monetized?'Monetized':'Non-monetary'}</span></div>
      </div>`).join('') : `<div class="empty" style="padding:16px;">No payouts yet.</div>`}
  </div>`;
}

function renderMemberDashboard(u){
  const today = dateStr(0);
  const rec = getRecord(u.id, today);
  const todayPct = rec ? effectivePercentage(rec) : null;
  const ws = weeklyStats(u.id);
  const scope = allMembers().filter(m=>m.status==='active').map(m=>m.id);
  const todayRank = dailyRanking(today, scope).find(r=>r.userId===u.id);
  const status = activityStatus(todayPct, u.assignedPercentage);
  const py = state.payouts;

  return `
    <div class="page-head"><div><h1>Welcome, ${escapeHtml(u.displayName)} \ud83d\udc4b</h1><div class="sub">${fmtDate(today)}</div></div></div>

    <div class="dash-hero">
    <div class="card profile-card">
      <div class="avatar">${initials(u.displayName)}</div>
      <div class="pname">${statusDot(status)}${escapeHtml(u.displayName)}${monetizedBadge(u.monetized)}</div>
      <div class="puser">@${escapeHtml(u.username)}</div>
      <div class="profile-links">
        <a class="link-btn ${u.xUsername?'':'off'}" ${u.xUsername?`href="https://x.com/${encodeURIComponent(u.xUsername)}" target="_blank"`:''}>\ud835\udd4a X Profile</a>
        <a class="link-btn ${u.whatsapp?'':'off'}" ${u.whatsapp?`href="https://wa.me/${u.whatsapp.replace(/\D/g,'')}" target="_blank"`:''}>\ud83d\udcac WhatsApp</a>
      </div>
    </div>

    <div class="grid-stats hero-stats">
      <div class="stat-card">
        <div class="label">Today's Repost</div>
        <div style="margin-top:8px;">${coloredBarHtml(todayPct, u.assignedPercentage, '100%')}</div>
        <div class="value blue" style="margin-top:8px;">${pctVsAssignedHtml(todayPct, u.assignedPercentage)}</div>
        <div class="muted" style="font-size:12.5px;">${rec?(rec.source==='csv'?'from today\u2019s CSV import':(rec.manualPercentage!==null?'set manually':'from today\u2019s posts')):'Not reported yet'}</div>
      </div>
      <div class="stat-card">
        <div class="label">Weekly Activity</div>
        <div class="pbar" style="margin-top:8px;"><span style="width:${ws.weeklyPct}%"></span></div>
        <div class="value blue" style="margin-top:8px;">${fmtPct(ws.weeklyPct)}</div>
        <div class="muted" style="font-size:12.5px;">average over 7 days</div>
      </div>
      <div class="stat-card">
        <div class="label">Today's Rank</div>
        <div class="value" style="margin-top:8px;">${todayRank ? medalHtml(todayRank.medal)+' #'+todayRank.rank : '\u2014'}</div>
        <div class="muted" style="font-size:12.5px;">out of ${scope.length} members</div>
      </div>
    </div>
    </div>

    <div class="grid-stats">
      ${communityTotalCardHtml(py, false)}
      <div class="stat-card"><div class="label">My Total Payout</div><div class="value blue">$${(py.myTotal||0).toFixed(2)}</div></div>
      <div class="stat-card">
        <div class="label">Last Premium Winner</div>
        ${py.lastPremiumWinner ? `<div class="value" style="font-size:16px;margin-top:6px;"${memberLinkAttrs(py.lastPremiumWinner.userId)}>\ud83c\udf1f ${escapeHtml(py.lastPremiumWinner.displayName)}</div><div class="muted" style="font-size:11.5px;">${fmtDate(py.lastPremiumWinner.date)}</div>` : `<div class="muted" style="margin-top:8px;">None yet</div>`}
      </div>
    </div>

    ${payoutsCardHtml('My Recent Payouts', py.myTotal, py.myRecent)}

    <div class="card">
      <h3>My Weekly Breakdown</h3>
      <div class="scrollx"><table><thead><tr><th>Date</th><th>Activity</th></tr></thead><tbody>
      ${ws.breakdown.map(b=>{
        const pct = b.record ? effectivePercentage(b.record) : null;
        return `<tr><td>${fmtDateShort(b.date)}</td>
        <td>${b.record?`${statusDot(activityStatus(pct,u.assignedPercentage))}${coloredBarHtml(pct,u.assignedPercentage)} ${pctVsAssignedHtml(pct,u.assignedPercentage)}`:'<span class="muted">Missing</span>'}</td></tr>`;
      }).join('')}
      </tbody></table></div>
    </div>
  `;
}

function renderMemberProfile(u){
  const py = state.payouts;
  return `
    <div class="page-head"><div><h1>My Profile</h1><div class="sub">Your account details</div></div></div>
    <div class="profile-grid">
    <div class="card profile-card">
      <div class="avatar">${initials(u.displayName)}</div>
      <div class="pname">${escapeHtml(u.displayName)}</div>
      <div class="puser">@${escapeHtml(u.username)}</div>
      <div class="profile-links">
        <a class="link-btn ${u.xUsername?'':'off'}" ${u.xUsername?`href="https://x.com/${encodeURIComponent(u.xUsername)}" target="_blank"`:''}>\ud835\udd4a X Profile</a>
        <a class="link-btn ${u.whatsapp?'':'off'}" ${u.whatsapp?`href="https://wa.me/${u.whatsapp.replace(/\D/g,'')}" target="_blank"`:''}>\ud83d\udcac WhatsApp</a>
      </div>
    </div>
    <div class="card">
      <h3>Details</h3>
      <div style="font-size:13.5px;line-height:2;">
        <div><span class="muted">Moderator:</span> ${u.moderatorId?escapeHtml(getUser(u.moderatorId).displayName):'\u2014'}</div>
        <div><span class="muted">Assigned target:</span> ${fmtPct(u.assignedPercentage)}</div>
        <div><span class="muted">Status:</span> <span class="badge ${u.status}">${u.status}</span></div>
      </div>
    </div>
    ${payoutsCardHtml('My Payouts', py.myTotal, py.myRecent)}
    </div>
  `;
}

function renderMemberWeekly(u){
  const ws = weeklyStats(u.id);
  return `
    <div class="page-head"><div><h1>My Weekly Activity</h1><div class="sub">This week \u00b7 % of days I met my ${fmtPct(u.assignedPercentage)} target \u2014 7/7 days = 100%</div></div></div>
    <div class="card" style="max-width:420px;text-align:center;">
      <div class="label muted" style="margin-bottom:6px;">Weekly Activity</div>
      <div style="font-size:34px;font-weight:700;color:var(--sky-deep);">${fmtPct(ws.weeklyPct)}</div>
    </div>
    <div class="card">
      <div class="scrollx"><table><thead><tr><th>Date</th><th>Today's Repost</th></tr></thead><tbody>
      ${ws.breakdown.map(b=>{
        const pct = b.record ? effectivePercentage(b.record) : null;
        const st = b.record ? activityStatus(pct, u.assignedPercentage) : null;
        return `<tr><td>${fmtDate(b.date)}</td>
        <td>${b.record?`${statusDot(st)}${coloredBarHtml(pct,u.assignedPercentage)} ${pctVsAssignedHtml(pct,u.assignedPercentage)}`:'<span class="muted">Missing</span>'}</td></tr>`;
      }).join('')}
      </tbody></table></div>
    </div>
  `;
}

/* ===================== Part 5: Members list + CRUD modal ===================== */

function renderMembersList(u){
  const isAdmin = u.role === 'admin';
  const editScopeIds = scopeForCurrentUser();
  const editScopeSet = new Set(editScopeIds);
  const viewScope = state.ui.params.memberViewScope || 'mine'; // moderators only: 'mine' | 'all'
  const viewIds = isAdmin ? allMembers().map(m=>m.id) : (viewScope==='all' ? allMembers().map(m=>m.id) : editScopeIds);
  const q = (state.ui.params.memberQuery || '').toLowerCase();
  const statusFilter = state.ui.params.memberStatus || 'all';
  let list = viewIds.map(getUser).filter(Boolean);
  if(q) list = list.filter(m => m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q) || (m.xUsername||'').toLowerCase().includes(q));
  if(statusFilter !== 'all') list = list.filter(m => m.status === statusFilter);

  const canAdd = isAdmin || canModeratorAct('addMembers');
  const canEdit = isAdmin || canModeratorAct('editMembers');
  const canRemove = isAdmin || canModeratorAct('removeMembers');
  const today = dateStr(0);

  return `
    <div class="page-head">
      <div><h1>${isAdmin?'Members':(viewScope==='all'?'All Members':'My Members')}</h1><div class="sub">${list.length} shown${!isAdmin?` \u00b7 ${editScopeIds.length} are yours to manage`:''}</div></div>
      ${canAdd?`<button class="btn btn-primary" style="width:auto;" onclick="openMemberModal(null)">+ Add Member</button>`:''}
    </div>
    <div class="card">
      <div class="toolbar" style="margin-bottom:16px;">
        ${!isAdmin?`
        <button class="btn ${viewScope==='mine'?'btn-primary':'btn-outline'} btn-sm" style="width:auto;" onclick="state.ui.params.memberViewScope='mine'; render();">My Members</button>
        <button class="btn ${viewScope==='all'?'btn-primary':'btn-outline'} btn-sm" style="width:auto;" onclick="state.ui.params.memberViewScope='all'; render();">All Members</button>
        `:''}
        <div class="search-box"><span class="ic">\ud83d\udd0d</span><input value="${escapeHtml(q)}" placeholder="Search name, username, X..." oninput="state.ui.params.memberQuery=this.value; renderMembersOnly();" /></div>
        <select class="select-sm" onchange="state.ui.params.memberStatus=this.value; render();">
          <option value="all" ${statusFilter==='all'?'selected':''}>All statuses</option>
          <option value="active" ${statusFilter==='active'?'selected':''}>Active</option>
          <option value="inactive" ${statusFilter==='inactive'?'selected':''}>Inactive</option>
        </select>
      </div>
      ${!isAdmin && viewScope==='all'?`<div class="muted" style="font-size:12px;margin-bottom:10px;">Showing the whole community \u2014 you can only Edit/Set Activity/Deactivate members assigned to you.</div>`:''}
      <div id="membersTableWrap" class="scrollx">${membersTableHtml(list, isAdmin, canEdit, canRemove, today, editScopeSet)}</div>
    </div>
  `;
}

function membersTableHtml(list, isAdmin, canEdit, canRemove, today, editScopeSet){
  if(!list.length) return `<div class="empty"><div class="big">\ud83d\udc65</div>No members found.</div>`;
  return `<table class="to-cards"><thead><tr>
      <th>Member</th><th>Links</th><th>Moderator</th><th>Today's Repost</th><th>Status</th><th></th>
    </tr></thead><tbody>
    ${list.map(m=>{
      const rec = getRecord(m.id, today);
      const pct = rec ? effectivePercentage(rec) : null;
      const mod = m.moderatorId ? getUser(m.moderatorId) : null;
      const inEditScope = isAdmin || !editScopeSet || editScopeSet.has(m.id);
      const rowCanEdit = canEdit && inEditScope;
      const rowCanRemove = canRemove && inEditScope;
      return `<tr>
        <td data-label="Member"><div class="cell-user"${memberLinkAttrs(m.id)}><div class="mini-avatar">${initials(m.displayName)}</div><div><div style="font-weight:600;">${escapeHtml(m.displayName)}${monetizedBadge(m.monetized)}</div><div class="muted" style="font-size:11.5px;">@${escapeHtml(m.username)}</div></div></div></td>
        <td data-label="Links">
          <a class="linkicon ${m.xUsername?'':'off'}" ${m.xUsername?`href="https://x.com/${encodeURIComponent(m.xUsername)}" target="_blank" onclick="event.stopPropagation()"`:''} title="X profile">\ud835\udd4a</a>
          <a class="linkicon ${m.whatsapp?'':'off'}" ${m.whatsapp?`href="https://wa.me/${m.whatsapp.replace(/\D/g,'')}" target="_blank" onclick="event.stopPropagation()"`:''} title="WhatsApp">\ud83d\udcac</a>
        </td>
        <td data-label="Moderator">${mod?escapeHtml(mod.displayName):'<span class="muted">\u2014</span>'}</td>
        <td data-label="Today's Repost">${pctVsAssignedHtml(pct, m.assignedPercentage)}</td>
        <td data-label="Status"><span class="badge ${m.status}">${m.status}</span></td>
        <td data-label="">
          ${rowCanEdit?`<button class="btn btn-outline btn-sm" onclick="event.stopPropagation();openMemberModal('${m.id}')">Edit</button>`:''}
          ${rowCanEdit?`<button class="btn btn-outline btn-sm" onclick="event.stopPropagation();openSetPercentModal('${m.id}')">Set Activity</button>`:''}
          ${rowCanRemove?`<button class="btn btn-outline btn-sm" onclick="event.stopPropagation();toggleMemberStatus('${m.id}')">${m.status==='active'?'Deactivate':'Reactivate'}</button>`:''}
          ${isAdmin?`<button class="btn btn-outline btn-sm" onclick="event.stopPropagation();permanentlyDeleteMember(event,'${m.id}')">Delete</button>`:''}
        </td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
}

function renderMembersOnly(){
  const wrap = document.getElementById('membersTableWrap');
  if(!wrap) return;
  const u = currentUser();
  const isAdmin = u.role==='admin';
  const editScopeIds = scopeForCurrentUser();
  const editScopeSet = new Set(editScopeIds);
  const viewScope = state.ui.params.memberViewScope || 'mine';
  const viewIds = isAdmin ? allMembers().map(m=>m.id) : (viewScope==='all' ? allMembers().map(m=>m.id) : editScopeIds);
  const q = (state.ui.params.memberQuery||'').toLowerCase();
  const statusFilter = state.ui.params.memberStatus || 'all';
  let list = viewIds.map(getUser).filter(Boolean);
  if(q) list = list.filter(m => m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q) || (m.xUsername||'').toLowerCase().includes(q));
  if(statusFilter !== 'all') list = list.filter(m => m.status === statusFilter);
  wrap.innerHTML = membersTableHtml(list, isAdmin, isAdmin||canModeratorAct('editMembers'), isAdmin||canModeratorAct('removeMembers'), dateStr(0), editScopeSet);
}

function openMemberModal(memberId){
  const u = currentUser();
  const editing = memberId ? getUser(memberId) : null;
  const isAdmin = u.role === 'admin';
  const moderatorOptions = allModerators().filter(m=>m.status==='active');
  openModal(`
    <div class="modal">
      <h2>${editing?'Edit Member':'Add Member'}</h2>
      <form onsubmit="return saveMember(event, ${editing?`'${editing.id}'`:'null'})">
        <div class="field-row">
          <div class="field"><label>Display name</label><input id="mDisplayName" required value="${editing?escapeHtml(editing.displayName):''}" /></div>
          <div class="field"><label>Username</label><input id="mUsername" required value="${editing?escapeHtml(editing.username):''}" /></div>
        </div>
        <div class="field"><label>Password ${editing?'(leave blank to keep current)':''}</label><input id="mPassword" type="text" placeholder="${editing?'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022':'Set a password'}" ${editing?'':'required'} /></div>
        <div class="field-row">
          <div class="field"><label>X (Twitter) username</label><input id="mX" placeholder="e.g. alexkhan" value="${editing?escapeHtml(editing.xUsername||''):''}" /></div>
          <div class="field"><label>WhatsApp number</label><input id="mWhatsapp" placeholder="e.g. 923001234567" value="${editing?escapeHtml(editing.whatsapp||''):''}" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Moderator</label>
            <select id="mModerator" ${isAdmin?'':'disabled'}>
              <option value="">\u2014 Unassigned \u2014</option>
              ${moderatorOptions.map(m=>`<option value="${m.id}" ${editing&&editing.moderatorId===m.id?'selected':''}>${escapeHtml(m.displayName)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Assigned %</label>
            <input id="mAssignedPct" type="number" min="10" max="100" required value="${editing?editing.assignedPercentage:50}" />
            <div class="muted" style="font-size:11.5px;margin-top:4px;">10\u2013100. Their daily bar/dot turns green at or above this, orange just under it, red well under.</div>
          </div>
        </div>
        <div class="check-row"><input type="checkbox" id="mMonetized" ${editing&&editing.monetized?'checked':''} /> Monetized (their X account earns payouts \u2014 shows a green \ud83d\udcb0 dot next to their name)</div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" style="width:auto;">${editing?'Save changes':'Add member'}</button>
        </div>
      </form>
    </div>
  `);
}

async function saveMember(e, memberId){
  e.preventDefault();
  const displayName = document.getElementById('mDisplayName').value.trim();
  const username = normalizeUsername(document.getElementById('mUsername').value);
  const password = document.getElementById('mPassword').value;
  const xUsername = normalizeUsername(document.getElementById('mX').value);
  const whatsapp = document.getElementById('mWhatsapp').value.replace(/[^\d]/g,'');
  const moderatorSel = document.getElementById('mModerator');
  const moderatorId = moderatorSel.disabled ? undefined : (moderatorSel.value || null);
  const assignedPercentage = document.getElementById('mAssignedPct').value;
  const monetized = document.getElementById('mMonetized').checked;
  if(assignedPercentage < 10 || assignedPercentage > 100){ toast('Assigned % must be between 10 and 100.', true); return false; }

  try{
    if(memberId){
      await apiSend('PUT', '/users/'+memberId, { username, displayName, password: password||undefined, xUsername, whatsapp, moderatorId, assignedPercentage, monetized });
      toast('Member updated.');
    }else{
      await apiSend('POST', '/users', { role:'member', username, password, displayName, xUsername, whatsapp, moderatorId, assignedPercentage, monetized });
      toast('Member added.');
    }
    closeModal();
    await fetchState();
    render();
  }catch(err){ toast(err.message, true); }
  return false;
}

/* ---- Set today's activity: admin/mod choose Posts OR Percentage ---- */
function openSetPercentModal(memberId){
  const m = getUser(memberId);
  const today = dateStr(0);
  const rec = getRecord(memberId, today);
  const startMode = rec && rec.manualPercentage !== null && rec.manualPercentage !== undefined ? 'percent' : 'posts';
  openModal(`
    <div class="modal">
      <h2>Set today's activity \u2014 ${escapeHtml(m.displayName)}</h2>
      <form onsubmit="return saveSetPercent(event,'${memberId}')">
        <div class="field">
          <label>Enter by</label>
          <div class="toolbar">
            <label class="check-row"><input type="radio" name="spMode" value="posts" ${startMode==='posts'?'checked':''} onchange="toggleEntryMode('sp','posts')"/> Number of posts</label>
            <label class="check-row"><input type="radio" name="spMode" value="percent" ${startMode==='percent'?'checked':''} onchange="toggleEntryMode('sp','percent')"/> Percentage directly</label>
          </div>
        </div>
        <div id="spPostsField" class="field ${startMode==='percent'?'hidden':''}">
          <label>Posts made today</label>
          <input id="spPosts" type="number" min="0" value="${rec&&rec.posts!==null?rec.posts:''}" />
          <div class="muted" style="font-size:12px;margin-top:4px;">Their % will be this number \u00f7 the whole community's posts today.</div>
        </div>
        <div id="spPercentField" class="field ${startMode==='posts'?'hidden':''}">
          <label>Percentage</label>
          <input id="spPercent" type="number" min="0" max="100" value="${rec&&rec.manualPercentage!==null&&rec.manualPercentage!==undefined?rec.manualPercentage:''}" />
        </div>
        <div class="field"><label>Reason ${startMode==='percent'?'(required)':'(optional, for correction notes)'}</label><input id="spReason" placeholder="e.g. Approved correction" value="${rec?escapeHtml(rec.reason||''):''}" /></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" style="width:auto;">Save</button>
        </div>
      </form>
    </div>
  `);
}

function toggleEntryMode(prefix, mode){
  const postsField = document.getElementById(prefix+'PostsField');
  const percentField = document.getElementById(prefix+'PercentField');
  if(mode==='posts'){ postsField.classList.remove('hidden'); percentField.classList.add('hidden'); }
  else { postsField.classList.add('hidden'); percentField.classList.remove('hidden'); }
}

async function saveSetPercent(e, memberId){
  e.preventDefault();
  const mode = document.querySelector('input[name="spMode"]:checked').value;
  const reason = document.getElementById('spReason').value.trim();
  let body;
  if(mode === 'percent'){
    const pct = document.getElementById('spPercent').value;
    if(pct === ''){ toast('Enter a percentage.', true); return false; }
    if(!reason){ toast('Please add a reason when setting a percentage directly.', true); return false; }
    body = { userId: memberId, date: dateStr(0), posts: null, manualPercentage: pct, reason };
  }else{
    const posts = document.getElementById('spPosts').value;
    if(posts === ''){ toast('Enter a number of posts.', true); return false; }
    body = { userId: memberId, date: dateStr(0), posts, manualPercentage: null, reason };
  }
  try{
    await apiSend('POST', '/activity', body);
    toast('Activity saved.');
    closeModal();
    await fetchState();
    render();
  }catch(err){ toast(err.message, true); }
  return false;
}

async function toggleMemberStatus(memberId){
  const m = getUser(memberId);
  try{
    await apiSend('PUT', '/users/'+memberId+'/status', {});
    toast(`${m.displayName} ${m.status==='active'?'deactivated':'reactivated'}.`);
    await fetchState();
    render();
  }catch(err){ toast(err.message, true); }
}

function permanentlyDeleteMember(e, memberId){
  const btn = e.currentTarget;
  requireConfirm(btn, 'Delete', ()=>{
    const m = getUser(memberId);
    apiSend('DELETE', '/users/'+memberId).then(async () => {
      toast(`${m.displayName} permanently deleted.`);
      await fetchState();
      render();
    }).catch(err => toast(err.message, true));
  });
}

/* ===================== Part 6: Moderators (admin only) ===================== */

function renderModeratorsList(u){
  if(u.role !== 'admin') return `<div class="empty">Not available.</div>`;
  const mods = allModerators();
  return `
    <div class="page-head">
      <div><h1>Moderators</h1><div class="sub">${mods.length} total</div></div>
      <button class="btn btn-primary" style="width:auto;" onclick="openModeratorModal(null)">+ Add Moderator</button>
    </div>
    <div class="card">
      <div class="scrollx"><table class="to-cards"><thead><tr><th>Moderator</th><th>Members</th><th>Links</th><th>Permissions</th><th>Status</th><th></th></tr></thead><tbody>
      ${mods.map(m=>{
        const memberCount = membersOf(m.id).length;
        const permCount = m.permissions ? Object.values(m.permissions).filter(Boolean).length : 0;
        return `<tr>
          <td data-label="Moderator"><div class="cell-user"><div class="mini-avatar">${initials(m.displayName)}</div><div><div style="font-weight:600;">${escapeHtml(m.displayName)}</div><div class="muted" style="font-size:11.5px;">@${escapeHtml(m.username)}</div></div></div></td>
          <td data-label="Members">${memberCount}</td>
          <td data-label="Links">
            <a class="linkicon ${m.xUsername?'':'off'}" ${m.xUsername?`href="https://x.com/${encodeURIComponent(m.xUsername)}" target="_blank"`:''}>\ud835\udd4a</a>
            <a class="linkicon ${m.whatsapp?'':'off'}" ${m.whatsapp?`href="https://wa.me/${m.whatsapp.replace(/\D/g,'')}" target="_blank"`:''}>\ud83d\udcac</a>
          </td>
          <td data-label="Permissions">${permCount}/6 granted</td>
          <td data-label="Status"><span class="badge ${m.status}">${m.status}</span></td>
          <td data-label="">
            <button class="btn btn-outline btn-sm" onclick="openModeratorModal('${m.id}')">Edit</button>
            <button class="btn btn-outline btn-sm" onclick="deactivateModerator('${m.id}')">${m.status==='active'?'Deactivate':'Reactivate'}</button>
          </td>
        </tr>`;
      }).join('')}
      </tbody></table></div>
    </div>
  `;
}

const PERM_LABELS = {
  addMembers:'Can add members', editMembers:'Can edit members', removeMembers:'Can remove/deactivate members',
  setPercentage:'Can set activity/percentages', importCsv:'Can import CSV', viewWeekly:'Can view weekly reports'
};

function openModeratorModal(modId){
  const editing = modId ? getUser(modId) : null;
  const perms = editing ? editing.permissions : { addMembers:true, editMembers:true, removeMembers:false, setPercentage:true, importCsv:false, viewWeekly:true };
  openModal(`
    <div class="modal">
      <h2>${editing?'Edit Moderator':'Add Moderator'}</h2>
      <form onsubmit="return saveModerator(event, ${editing?`'${editing.id}'`:'null'})">
        <div class="field-row">
          <div class="field"><label>Display name</label><input id="modDisplayName" required value="${editing?escapeHtml(editing.displayName):''}" /></div>
          <div class="field"><label>Username</label><input id="modUsername" required value="${editing?escapeHtml(editing.username):''}" /></div>
        </div>
        <div class="field"><label>Password ${editing?'(leave blank to keep current)':''}</label><input id="modPassword" type="text" ${editing?'':'required'} placeholder="${editing?'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022':'Set a password'}" /></div>
        <div class="field-row">
          <div class="field"><label>X (Twitter) username</label><input id="modX" value="${editing?escapeHtml(editing.xUsername||''):''}" /></div>
          <div class="field"><label>WhatsApp number</label><input id="modWhatsapp" value="${editing?escapeHtml(editing.whatsapp||''):''}" /></div>
        </div>
        <label style="display:block;font-size:13px;font-weight:600;color:var(--ink-soft);margin:14px 0 4px;">Permissions</label>
        <div class="perm-grid">
          ${Object.keys(PERM_LABELS).map(k=>`<label class="check-row"><input type="checkbox" id="perm_${k}" ${perms[k]?'checked':''}/> ${PERM_LABELS[k]}</label>`).join('')}
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" style="width:auto;">${editing?'Save changes':'Add moderator'}</button>
        </div>
      </form>
    </div>
  `);
}

async function saveModerator(e, modId){
  e.preventDefault();
  const displayName = document.getElementById('modDisplayName').value.trim();
  const username = normalizeUsername(document.getElementById('modUsername').value);
  const password = document.getElementById('modPassword').value;
  const xUsername = normalizeUsername(document.getElementById('modX').value);
  const whatsapp = document.getElementById('modWhatsapp').value.replace(/[^\d]/g,'');
  const permissions = {};
  Object.keys(PERM_LABELS).forEach(k => permissions[k] = document.getElementById('perm_'+k).checked);

  try{
    if(modId){
      await apiSend('PUT', '/users/'+modId, { username, displayName, password: password||undefined, xUsername, whatsapp, permissions });
      toast('Moderator updated.');
    }else{
      await apiSend('POST', '/users', { role:'moderator', username, password, displayName, xUsername, whatsapp, permissions });
      toast('Moderator added.');
    }
    closeModal();
    await fetchState();
    render();
  }catch(err){ toast(err.message, true); }
  return false;
}

async function deactivateModerator(modId){
  const m = getUser(modId);
  try{
    await apiSend('PUT', '/users/'+modId+'/status', {});
    toast(m.status==='active' ? 'Moderator deactivated.' : 'Moderator reactivated.');
    await fetchState();
    render();
  }catch(err){
    if(err.data && err.data.error === 'needs_reassignment'){
      openReassignModal(modId, membersOf(modId));
    }else{
      toast(err.message, true);
    }
  }
}

function openReassignModal(modId, memberList){
  const m = getUser(modId);
  const others = allModerators().filter(x=>x.id!==modId && x.status==='active');
  openModal(`
    <div class="modal">
      <h2>Deactivate ${escapeHtml(m.displayName)}?</h2>
      <p class="muted" style="font-size:13.5px;margin-bottom:14px;">${memberList.length} member${memberList.length>1?'s':''} currently assigned to them. Choose a replacement moderator so they don't lose coverage:</p>
      <div class="field">
        <label>Reassign to</label>
        <select id="reassignTarget">
          <option value="">\u2014 Leave unassigned \u2014</option>
          ${others.map(o=>`<option value="${o.id}">${escapeHtml(o.displayName)}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" style="width:auto;" onclick="confirmReassignAndDeactivate('${modId}')">Reassign All & Deactivate</button>
      </div>
    </div>
  `);
}

async function confirmReassignAndDeactivate(modId){
  const target = document.getElementById('reassignTarget').value || null;
  try{
    await apiSend('PUT', '/users/'+modId+'/status', { reassignTo: target });
    toast('Moderator deactivated and members reassigned.');
    closeModal();
    await fetchState();
    render();
  }catch(err){ toast(err.message, true); }
}

/* ===================== Part 7: Daily reports ===================== */

function renderDailyReports(u){
  const editScopeIds = scopeForCurrentUser(); // who this actor can actually add/edit records for
  const editScopeSet = new Set(editScopeIds);
  const viewIds = allMembers().filter(m=>m.status==='active').map(m=>m.id); // everyone sees everyone's daily reports
  const date = state.ui.params.dailyDate || dateStr(0);
  const canEdit = u.role==='admin' || canModeratorAct('setPercentage');
  const ranking = dailyRanking(date, viewIds);
  const rankedIds = new Set(ranking.map(r=>r.userId));
  const missing = viewIds.map(getUser).filter(m=>m && !rankedIds.has(m.id));
  const communityTotal = dailyCommunityTotal(date);

  return `
    <div class="page-head">
      <div><h1>Daily Reports</h1><div class="sub">One record per member per day \u2014 the source of truth \u2014 visible to the whole community</div></div>
      <div class="toolbar">
        <input type="date" class="select-sm" value="${date}" max="${dateStr(0)}" onchange="state.ui.params.dailyDate=this.value; render();" />
        ${canEdit?`<button class="btn btn-primary" style="width:auto;" onclick="openAddDailyModal('${date}')">+ Add Individual Report</button>`:''}
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>${fmtDate(date)}</h3><span class="badge role">Community total: ${communityTotal} posts</span></div>
      <div class="scrollx"><table class="to-cards"><thead><tr><th>Rank</th><th>Member</th><th>Today's Repost</th><th>Source</th><th></th></tr></thead><tbody>
      ${ranking.map(r=>{
        const rec = r.record;
        const st = activityStatus(r.pct, r.user.assignedPercentage);
        const rowCanEdit = canEdit && editScopeSet.has(r.userId);
        return `<tr>
          <td data-label="Rank">${medalHtml(r.medal)} #${r.rank}</td>
          <td data-label="Member"><div class="cell-user"${memberLinkAttrs(r.userId)}>${statusDot(st)}<div class="mini-avatar">${initials(r.user.displayName)}</div>${escapeHtml(r.user.displayName)}${monetizedBadge(r.user.monetized)}</div></td>
          <td data-label="Today's Repost">${coloredBarHtml(r.pct, r.user.assignedPercentage)} ${pctVsAssignedHtml(r.pct, r.user.assignedPercentage)} ${activitySourceTag(rec)}</td>
          <td data-label="Source"><span class="badge role">${rec.source}</span></td>
          <td data-label="">${rowCanEdit?`<button class="btn btn-outline btn-sm" onclick="openAddDailyModal('${date}','${r.userId}')">Edit</button>`:''}</td>
        </tr>`;
      }).join('')}
      ${missing.map(m=>{
        const rowCanEdit = canEdit && editScopeSet.has(m.id);
        return `<tr>
          <td data-label="Rank"><span class="muted">\u2014</span></td>
          <td data-label="Member"><div class="cell-user"${m.status!=='active'?' style="opacity:.55;"':''}><div class="mini-avatar">${initials(m.displayName)}</div>${escapeHtml(m.displayName)}${monetizedBadge(m.monetized)}${m.status!=='active'?' <span class="badge inactive" style="margin-left:6px;">inactive</span>':''}</div></td>
          <td data-label="Today's Repost">${m.status==='active'?`<span class="row-status warn">Not reported</span> <span class="muted" style="font-size:11.5px;">(assigned ${fmtPct(m.assignedPercentage)})</span>`:'<span class="muted">\u2014</span>'}</td>
          <td data-label="Source">\u2014</td>
          <td data-label="">${rowCanEdit?`<button class="btn btn-outline btn-sm" onclick="openAddDailyModal('${date}','${m.id}')">Add</button>`:''}</td>
        </tr>`;
      }).join('')}
      ${(!ranking.length && !missing.length) ? `<tr><td colspan="5"><div class="empty">No active members yet.</div></td></tr>` : ''}
      </tbody></table></div>
    </div>
  `;
}

function openAddDailyModal(date, memberId){
  const scopeIds = scopeForCurrentUser();
  const members = scopeIds.map(getUser).filter(m=>m && m.status==='active');
  const rec = memberId ? getRecord(memberId, date) : null;
  const startMode = rec && rec.manualPercentage !== null && rec.manualPercentage !== undefined ? 'percent' : 'posts';
  openModal(`
    <div class="modal">
      <h2>${rec?'Edit':'Add'} Daily Report</h2>
      <form onsubmit="return saveDailyModal(event,'${date}')">
        <div class="field"><label>Member</label>
          <select id="dmMember" ${memberId?'disabled':''}>
            ${members.map(m=>`<option value="${m.id}" ${memberId===m.id?'selected':''}>${escapeHtml(m.displayName)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Enter by</label>
          <div class="toolbar">
            <label class="check-row"><input type="radio" name="dmMode" value="posts" ${startMode==='posts'?'checked':''} onchange="toggleEntryMode('dm','posts')"/> Number of posts</label>
            <label class="check-row"><input type="radio" name="dmMode" value="percent" ${startMode==='percent'?'checked':''} onchange="toggleEntryMode('dm','percent')"/> Percentage directly</label>
          </div>
        </div>
        <div id="dmPostsField" class="field ${startMode==='percent'?'hidden':''}">
          <label>Posts made</label>
          <input id="dmPosts" type="number" min="0" value="${rec&&rec.posts!==null?rec.posts:''}" />
        </div>
        <div id="dmPercentField" class="field ${startMode==='posts'?'hidden':''}">
          <label>Percentage</label>
          <input id="dmPercent" type="number" min="0" max="100" value="${rec&&rec.manualPercentage!==null&&rec.manualPercentage!==undefined?rec.manualPercentage:''}" />
        </div>
        <div class="field"><label>Reason ${startMode==='percent'?'(required)':'(optional)'}</label><input id="dmReason" value="${rec?escapeHtml(rec.reason||''):''}" /></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" style="width:auto;">Save</button>
        </div>
      </form>
    </div>
  `);
}

async function saveDailyModal(e, date){
  e.preventDefault();
  const memberId = document.getElementById('dmMember').value;
  const mode = document.querySelector('input[name="dmMode"]:checked').value;
  const reason = document.getElementById('dmReason').value.trim();
  let body;
  if(mode === 'percent'){
    const pct = document.getElementById('dmPercent').value;
    if(pct === ''){ toast('Enter a percentage.', true); return false; }
    if(!reason){ toast('Please add a reason when setting a percentage directly.', true); return false; }
    body = { userId: memberId, date, posts: null, manualPercentage: pct, reason };
  }else{
    const posts = document.getElementById('dmPosts').value;
    if(posts === ''){ toast('Enter a number of posts.', true); return false; }
    body = { userId: memberId, date, posts, manualPercentage: null, reason };
  }
  try{
    await apiSend('POST', '/activity', body);
    toast('Daily report saved.');
    closeModal();
    await fetchState();
    render();
  }catch(err){ toast(err.message, true); }
  return false;
}

/* ===================== Part 8: CSV Import (upload -> preview -> confirm) ===================== */
/* CSV export from the external repost-tracking tool has many computed columns
   (total_posts, video_posts, pool totals, quality/old/outside repost counts...).
   We only ever read two of them: username, and repost_percentage — everything
   else is ignored. The imported percentage always overwrites whatever was
   there before (manual assignment or an earlier import) for that member/date. */

var importState = null; // { date, csvText, rows: [...] }

function renderImports(u){
  const canImportDaily = u.role==='admin' || canModeratorAct('importCsv');
  const canImportMembers = u.role==='admin' || canModeratorAct('addMembers') || canModeratorAct('editMembers');
  if(!canImportDaily && !canImportMembers) return `<div class="empty"><div class="big">\ud83d\udd12</div>You don't have permission to import CSV files.</div>`;

  const tab = state.ui.params.importTab || (canImportDaily ? 'daily' : 'members');
  const date = state.ui.params.importDate || dateStr(0);

  return `
    <div class="page-head">
      <div><h1>CSV Imports</h1><div class="sub">Bulk-update activity or bulk-add/update members \u2014 both always previewed before saving</div></div>
      <div class="toolbar">
        ${canImportDaily?`<button class="btn ${tab==='daily'?'btn-primary':'btn-outline'} btn-sm" style="width:auto;" onclick="state.ui.params.importTab='daily'; render();">Daily Activity</button>`:''}
        ${canImportMembers?`<button class="btn ${tab==='members'?'btn-primary':'btn-outline'} btn-sm" style="width:auto;" onclick="state.ui.params.importTab='members'; render();">Members</button>`:''}
      </div>
    </div>
    ${tab==='daily' && canImportDaily ? `
    <div class="card">
      <div class="field" style="max-width:220px;"><label>Report date</label><input type="date" value="${date}" max="${dateStr(0)}" onchange="state.ui.params.importDate=this.value; importState=null; render();" /></div>
      <div class="drop">
        <div style="font-size:26px;margin-bottom:8px;">\u2b06\ufe0f</div>
        <div>Drop a CSV file here or choose one below.</div>
        <div class="muted" style="margin-top:6px;">Needs a header row with <code>username</code> and <code>repost_percentage</code> columns. If <code>total_posts</code> is present it's also captured \u2014 it feeds the "Today's Community Posts" total on the dashboard, even though it doesn't affect the imported %. Any other columns are ignored.</div>
        <input type="file" accept=".csv,text/csv" style="margin-top:14px;" onchange="handleCsvFile(event,'${date}')" />
      </div>
      <div class="muted" style="font-size:12.5px;margin-top:10px;">Unknown usernames are never auto-created here \u2014 add them on the Members tab first. Duplicate rows are flagged, not silently merged. The imported percentage always overwrites whatever was there before for that member/date.</div>
    </div>
    <div id="importPreviewWrap">${importState ? importPreviewHtml() : ''}</div>
    ` : ''}
    ${tab==='members' && canImportMembers ? renderMemberImportPanel(u) : ''}
  `;
}

/* ---------------- Members CSV import (bulk add/update accounts) ----------------
   Both import flows below send the raw CSV text to the server twice: once with
   confirm:false to get a validated preview (server has the full, unscoped user
   list, so this is authoritative — not just a client-side guess), then again
   with confirm:true once the admin/mod clicks Import. */

var memberImportState = null; // { csvText, rows: [...] }

function renderMemberImportPanel(u){
  const isAdmin = u.role === 'admin';
  return `
    <div class="card">
      <div class="drop">
        <div style="font-size:26px;margin-bottom:8px;">\ud83d\udc65</div>
        <div>Drop a member-list CSV here or choose one below.</div>
        <div class="muted" style="margin-top:6px;">Header row needs <code>username</code> and <code>display_name</code>. Optional columns: <code>x_username</code>, <code>whatsapp</code>${isAdmin?', <code>moderator</code> (a moderator\'s username)':''}, <code>password</code>.</div>
        <input type="file" accept=".csv,text/csv" style="margin-top:14px;" onchange="handleMemberCsvFile(event)" />
      </div>
      <div class="muted" style="font-size:12.5px;margin-top:10px;">
        A username that already exists is <b>updated</b> (display name, X, WhatsApp${isAdmin?', moderator':''} \u2014 password only changes if the column is filled in). A new username is <b>created</b>, with a default password of <code>changeme123</code> if none is given.
        ${isAdmin?'':' New/updated members are assigned to you automatically \u2014 the moderator column, if present, is ignored for your imports.'}
      </div>
    </div>
    <div id="memberImportPreviewWrap">${memberImportState ? memberImportPreviewHtml() : ''}</div>
  `;
}

function handleMemberCsvFile(evt){
  const file = evt.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try{
      const data = await apiSend('POST', '/users/import', { csvText: reader.result, confirm: false });
      memberImportState = { csvText: reader.result, rows: data.rows };
      document.getElementById('memberImportPreviewWrap').innerHTML = memberImportPreviewHtml();
    }catch(err){ toast(err.message, true); }
  };
  reader.onerror = () => toast('Could not read that file.', true);
  reader.readAsText(file);
}

function memberImportPreviewHtml(){
  if(!memberImportState) return '';
  const { rows } = memberImportState;
  const creates = rows.filter(r=>r.status==='create').length;
  const updates = rows.filter(r=>r.status==='update').length;
  const errors = rows.filter(r=>r.status==='error').length;
  const importable = creates + updates;

  return `
    <div class="card">
      <div class="card-head"><h3>Preview</h3></div>
      <div class="import-summary">
        <div class="chip ok">\u2713 New: ${creates}</div>
        <div class="chip ok">\u2713 Updated: ${updates}</div>
        ${errors?`<div class="chip warn">\u26a0 Errors: ${errors}</div>`:''}
      </div>
      <div class="scrollx"><table class="to-cards"><thead><tr><th>Username</th><th>Display name</th><th>Result</th><th>Note</th></tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td data-label="Username">${escapeHtml(r.rawUsername)}</td>
        <td data-label="Display name">${escapeHtml(r.displayName||'')}</td>
        <td data-label="Result">${r.status==='error'?`<span class="row-status warn">\u26a0 error</span>`:`<span class="row-status ok">\u2713 ${r.status}</span>`}</td>
        <td data-label="Note">${escapeHtml(r.note||'')}</td>
      </tr>`).join('')}
      </tbody></table></div>
      <div class="modal-actions" style="margin-top:16px;">
        <button class="btn btn-outline" onclick="memberImportState=null; document.getElementById('memberImportPreviewWrap').innerHTML='';">Cancel</button>
        <button class="btn btn-primary" style="width:auto;" onclick="confirmMemberImport()">Import ${importable} Record${importable===1?'':'s'}</button>
      </div>
    </div>
  `;
}

async function confirmMemberImport(){
  if(!memberImportState || !memberImportState.rows.some(r=>r.status!=='error')){ toast('Nothing valid to import.', true); return; }
  try{
    const data = await apiSend('POST', '/users/import', { csvText: memberImportState.csvText, confirm: true });
    toast(`Imported ${data.created+data.updated} member${data.created+data.updated===1?'':'s'} (${data.created} new, ${data.updated} updated).`);
    memberImportState = null;
    await fetchState();
    render();
  }catch(err){ toast(err.message, true); }
}

function handleCsvFile(evt, date){
  const file = evt.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try{
      const data = await apiSend('POST', '/activity/import', { csvText: reader.result, date, confirm: false });
      importState = { date, csvText: reader.result, rows: data.rows };
      document.getElementById('importPreviewWrap').innerHTML = importPreviewHtml();
    }catch(err){ toast(err.message, true); }
  };
  reader.onerror = () => toast('Could not read that file.', true);
  reader.readAsText(file);
}

function importPreviewHtml(){
  if(!importState) return '';
  const { rows, date } = importState;
  const matched = rows.filter(r=>r.status==='ok').length;
  const notFound = rows.filter(r=>r.status==='notfound').length;
  const duplicates = rows.filter(r=>r.status==='duplicate').length;
  const errors = rows.filter(r=>r.status==='error').length;
  const postsTotal = rows.filter(r=>r.status==='ok' && r.posts!==null).reduce((s,r)=>s+r.posts,0);
  const hasPosts = rows.some(r=>r.posts!==null);

  return `
    <div class="card">
      <div class="card-head"><h3>Preview \u2014 ${fmtDate(date)}</h3></div>
      <div class="import-summary">
        <div class="chip ok">\u2713 Matched: ${matched}</div>
        ${notFound?`<div class="chip warn">\u26a0 Not found: ${notFound}</div>`:''}
        ${duplicates?`<div class="chip warn">\u26a0 Duplicates: ${duplicates}</div>`:''}
        ${errors?`<div class="chip warn">\u26a0 Errors: ${errors}</div>`:''}
        ${hasPosts?`<div class="chip">Community posts in this file: ${postsTotal}</div>`:''}
      </div>
      <div class="scrollx"><table class="to-cards"><thead><tr><th>Username</th>${hasPosts?'<th>Posts</th>':''}<th>Repost %</th><th>Note</th></tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td data-label="Username">${escapeHtml(r.rawUsername)}</td>
        ${hasPosts?`<td data-label="Posts">${r.posts===null?'<span class="muted">\u2014</span>':r.posts}</td>`:''}
        <td data-label="Repost %">${r.status==='ok'?`<span class="row-status ok">\u2713 ${fmtPct(r.pct)}</span>`:`<span class="row-status warn">\u26a0 ${r.status}</span>`}</td>
        <td data-label="Note">${escapeHtml(r.note||'')}</td>
      </tr>`).join('')}
      </tbody></table></div>
      <div class="modal-actions" style="margin-top:16px;">
        <button class="btn btn-outline" onclick="importState=null; document.getElementById('importPreviewWrap').innerHTML='';">Cancel</button>
        <button class="btn btn-primary" style="width:auto;" onclick="confirmImport()">Import ${matched} Valid Record${matched===1?'':'s'}</button>
      </div>
    </div>
  `;
}

async function confirmImport(){
  if(!importState || !importState.rows.some(r=>r.status==='ok')){ toast('Nothing valid to import.', true); return; }
  try{
    const data = await apiSend('POST', '/activity/import', { csvText: importState.csvText, date: importState.date, confirm: true });
    toast(`Imported ${data.count} record${data.count===1?'':'s'}.`);
    importState = null;
    await fetchState();
    render();
  }catch(err){ toast(err.message, true); }
}

/* ===================== Part 9: Weekly reports ===================== */

function renderWeeklyReports(u){
  const isAdmin = u.role === 'admin';
  const editScopeIds = scopeForCurrentUser();
  const viewScope = state.ui.params.weeklyViewScope || 'mine';
  const viewIds = isAdmin ? allMembers().map(m=>m.id) : (viewScope==='all' ? allMembers().map(m=>m.id) : editScopeIds);
  const rows = viewIds.map(id=>{
    const m = getUser(id);
    const ws = weeklyStats(id);
    const todayRec = getRecord(id, dateStr(0));
    return { m, ws, todayPct: todayRec?effectivePercentage(todayRec):null };
  }).filter(r=>r.m);
  rows.sort((a,b)=>b.ws.weeklyPct - a.ws.weeklyPct);

  return `
    <div class="page-head">
      <div><h1>Weekly Reports</h1><div class="sub">This week \u00b7 % of days each member met their assigned target \u2014 7/7 = 100%</div></div>
      ${!isAdmin?`<div class="toolbar">
        <button class="btn ${viewScope==='mine'?'btn-primary':'btn-outline'} btn-sm" style="width:auto;" onclick="state.ui.params.weeklyViewScope='mine'; render();">My Members</button>
        <button class="btn ${viewScope==='all'?'btn-primary':'btn-outline'} btn-sm" style="width:auto;" onclick="state.ui.params.weeklyViewScope='all'; render();">All Members</button>
      </div>`:''}
    </div>
    <div class="card">
      <div class="scrollx"><table class="to-cards"><thead><tr><th>Member</th><th>Today</th><th>Weekly</th><th></th></tr></thead><tbody>
      ${rows.map(r=>{
        const st = activityStatus(r.todayPct, r.m.assignedPercentage);
        return `<tr>
        <td data-label="Member"><div class="cell-user"${memberLinkAttrs(r.m.id)}>${statusDot(st)}<div class="mini-avatar">${initials(r.m.displayName)}</div>${escapeHtml(r.m.displayName)}${monetizedBadge(r.m.monetized)}</div></td>
        <td data-label="Today">${pctVsAssignedHtml(r.todayPct, r.m.assignedPercentage)}</td>
        <td data-label="Weekly"><div class="pbar" style="display:inline-block;width:80px;vertical-align:middle;"><span style="width:${r.ws.weeklyPct}%"></span></div> ${fmtPct(r.ws.weeklyPct)}</td>
        <td data-label=""><button class="btn btn-outline btn-sm" onclick="goto('memberDetail',{userId:'${r.m.id}'})">View \u2192</button></td>
      </tr>`;
      }).join('')}
      ${!rows.length?`<tr><td colspan="4"><div class="empty">No members in scope.</div></td></tr>`:''}
      </tbody></table></div>
    </div>
  `;
}

function renderMemberDetail(u, memberId){
  if(!canViewMemberDetail(memberId)){
    return `<div class="empty"><div class="big">🔒</div>You can only view your own weekly report and payouts.<br><button class="btn btn-outline btn-sm" style="margin-top:12px;" onclick="goto('weekly')">Go to my weekly activity</button></div>`;
  }
  const m = getUser(memberId);
  if(!m || m.role !== 'member'){
    return `<div class="empty"><div class="big">\ud83d\udd12</div>That member could not be found.<br><button class="btn btn-outline btn-sm" style="margin-top:12px;" onclick="goto('directory')">\u2190 Back</button></div>`;
  }
  const ws = weeklyStats(memberId);
  const mod = m.moderatorId ? getUser(m.moderatorId) : null;
  const memberPayouts = state.payouts.scoped.filter(p=>p.userId===memberId).slice(0,8);
  const memberPayoutTotal = memberPayouts.reduce((s,p)=>s+(p.amount||0),0);
  return `
    <button class="btn btn-ghost btn-sm" style="margin-bottom:14px;" onclick="history.length>1?goto('directory'):goto('dashboard')">\u2190 Back</button>
    <div class="page-head">
      <div><h1>${escapeHtml(m.displayName)}${monetizedBadge(m.monetized)}</h1><div class="sub">@${escapeHtml(m.username)} \u00b7 Moderator: ${mod?escapeHtml(mod.displayName):'\u2014'} \u00b7 Assigned target: ${fmtPct(m.assignedPercentage)}</div></div>
      <div class="profile-links">
        <a class="link-btn ${m.xUsername?'':'off'}" ${m.xUsername?`href="https://x.com/${encodeURIComponent(m.xUsername)}" target="_blank"`:''}>\ud835\udd4a X</a>
        <a class="link-btn ${m.whatsapp?'':'off'}" ${m.whatsapp?`href="https://wa.me/${m.whatsapp.replace(/\D/g,'')}" target="_blank"`:''}>\ud83d\udcac WhatsApp</a>
      </div>
    </div>
    <div class="grid-stats">
      <div class="stat-card"><div class="label">Weekly Activity</div><div class="value blue">${fmtPct(ws.weeklyPct)}</div></div>
      <div class="stat-card"><div class="label">Days Reported</div><div class="value">${ws.daysReported}/7</div></div>
    </div>
    <div class="card">
      <h3>7-Day Breakdown</h3>
      <div class="scrollx"><table><thead><tr><th>Date</th><th>Today's Repost</th><th>Source</th></tr></thead><tbody>
      ${ws.breakdown.map(b=>{
        const pct = b.record ? effectivePercentage(b.record) : null;
        const st = b.record ? activityStatus(pct, m.assignedPercentage) : null;
        return `<tr><td>${fmtDate(b.date)}</td>
        <td>${b.record?`${statusDot(st)}${coloredBarHtml(pct,m.assignedPercentage)} ${pctVsAssignedHtml(pct,m.assignedPercentage)}`:'<span class="row-status warn">Missing</span>'}</td>
        <td>${b.record?`<span class="badge role">${b.record.source}</span>`:'\u2014'}</td></tr>`;
      }).join('')}
      </tbody></table></div>
    </div>
    ${payoutsCardHtml('Payouts', memberPayoutTotal, memberPayouts)}
  `;
}

/* ===================== Part 10: Leaderboard ===================== */

function renderLeaderboard(u){
  const scopeIds = scopeForCurrentUser();
  const mode = state.ui.params.lbMode || 'weekly';
  const today = dateStr(0);
  const dRank = dailyRanking(today, scopeIds);
  const wRank = weeklyLeaderboard(scopeIds);
  const rows = mode==='daily' ? dRank : wRank;
  const podium = rows.slice(0,3);
  const isAdmin = u.role === 'admin';

  function rowStatus(r){
    const todayRec = getRecord(r.userId, today);
    return todayRec ? activityStatus(effectivePercentage(todayRec), r.user.assignedPercentage) : null;
  }

  function podiumSlot(r, pos){
    if(!r) return `<div class="podium-slot p${pos}"><div class="empty" style="padding:10px;">\u2014</div></div>`;
    return `<div class="podium-slot p${pos}">
      <div class="rank-medal">${medalHtml(r.medal)}</div>
      <div class="mini-avatar" style="margin:0 auto 8px;width:36px;height:36px;font-size:14px;">${initials(r.user.displayName)}</div>
      <div class="pname">${statusDot(rowStatus(r))}${escapeHtml(r.user.displayName)}${monetizedBadge(r.user.monetized)}</div>
      <div class="pscore">${mode==='daily'?fmtPct(r.pct):fmtPct(r.weeklyPct)}</div>
      <div class="psub">${mode==='daily'?`today's repost`:`${r.points} gold day${r.points===1?'':'s'} this week`}</div>
    </div>`;
  }

  const py = state.payouts;

  return `
    <div class="page-head">
      <div><h1>\ud83c\udfc6 Leaderboard</h1><div class="sub">Daily toppers get Gold/Silver/Bronze \u00b7 weekly rank is built from 1st-place days</div></div>
      <div class="toolbar">
        <button class="btn ${mode==='daily'?'btn-primary':'btn-outline'} btn-sm" style="width:auto;" onclick="state.ui.params.lbMode='daily'; render();">Today</button>
        <button class="btn ${mode==='weekly'?'btn-primary':'btn-outline'} btn-sm" style="width:auto;" onclick="state.ui.params.lbMode='weekly'; render();">This Week</button>
        ${isAdmin?`<button class="btn btn-primary btn-sm" style="width:auto;" onclick="openAwardPremiumModal()">\ud83c\udf1f Award Weekly Premium</button>`:''}
      </div>
    </div>

    ${py.lastPremiumWinner?`<div class="card banner">
      <div style="font-size:22px;">\ud83c\udf1f</div>
      <div style="flex:1;min-width:0;"><b>${escapeHtml(py.lastPremiumWinner.displayName)}</b> won the last Premium award (${fmtDate(py.lastPremiumWinner.date)}${py.lastPremiumWinner.amount!==undefined?`, $${(py.lastPremiumWinner.amount||0).toFixed(2)}`:''})</div>
      ${canViewMemberDetail(py.lastPremiumWinner.userId)?`<button class="btn btn-outline btn-sm" onclick="goto('memberDetail',{userId:'${py.lastPremiumWinner.userId}'})">View \u2192</button>`:''}
    </div>`:''}

    <div class="podium">
      ${podiumSlot(podium[1],2)}
      ${podiumSlot(podium[0],1)}
      ${podiumSlot(podium[2],3)}
    </div>

    <div class="card">
      <h3>${mode==='daily'?'Today\u2019s Full Ranking \u2014 '+fmtDate(today):'Weekly Points \u2014 this week'}</h3>
      <div class="scrollx"><table class="to-cards"><thead><tr><th>Rank</th><th>Member</th>${mode==='daily'?'<th>Today\'s Repost</th>':'<th>Gold</th><th>Silver</th><th>Bronze</th><th>Points</th><th>Weekly %</th>'}</tr></thead><tbody>
      ${rows.map(r=>mode==='daily'?`<tr>
          <td data-label="Rank">${medalHtml(r.medal)} #${r.rank}</td>
          <td data-label="Member"><div class="cell-user"${memberLinkAttrs(r.userId)}>${statusDot(rowStatus(r))}<div class="mini-avatar">${initials(r.user.displayName)}</div>${escapeHtml(r.user.displayName)}${monetizedBadge(r.user.monetized)}</div></td>
          <td data-label="Today's Repost">${pctVsAssignedHtml(r.pct, r.user.assignedPercentage)}</td>
        </tr>`:`<tr>
          <td data-label="Rank">${medalHtml(r.medal)} #${r.rank}</td>
          <td data-label="Member"><div class="cell-user"${memberLinkAttrs(r.userId)}>${statusDot(rowStatus(r))}<div class="mini-avatar">${initials(r.user.displayName)}</div>${escapeHtml(r.user.displayName)}${monetizedBadge(r.user.monetized)}</div></td>
          <td data-label="Gold">\ud83e\udd47 ${r.goldDays}</td>
          <td data-label="Silver">\ud83e\udd48 ${r.silverDays}</td>
          <td data-label="Bronze">\ud83e\udd49 ${r.bronzeDays}</td>
          <td data-label="Points"><b>${r.points}</b></td>
          <td data-label="Weekly %">${fmtPct(r.weeklyPct)}</td>
        </tr>`).join('')}
      ${!rows.length?`<tr><td colspan="7"><div class="empty">No activity recorded yet.</div></td></tr>`:''}
      </tbody></table></div>
      <div class="muted" style="font-size:12px;margin-top:10px;">Weekly points = number of days a member finished #1 (Gold) this week. Ties are broken by weekly activity %. Dots show today's status vs each member's assigned target: <span class="status-dot green" style="margin:0 2px;"></span>on target, <span class="status-dot orange" style="margin:0 2px;"></span>just under, <span class="status-dot red" style="margin:0 2px;"></span>well under. <span class="monetized-dot" style="margin:0 2px;"></span>= monetized.</div>
    </div>
  `;
}

function renderDirectory(u){
  return `
    <div class="page-head"><div><h1>\ud83d\udc65 All Community Members</h1><div class="sub">Every active member \u2014 name, username, and X link</div></div></div>
    <div class="card">
      <div class="directory-grid">
        ${state.directory.map(d=>`<div class="directory-item">
          <div class="mini-avatar">${initials(d.displayName)}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13.5px;"${memberLinkAttrs(d.id)}>${escapeHtml(d.displayName)}${monetizedBadge(d.monetized)}</div>
            <div class="muted" style="font-size:11.5px;">@${escapeHtml(d.username)}</div>
          </div>
          <a class="linkicon ${d.xUsername?'':'off'}" ${d.xUsername?`href="https://x.com/${encodeURIComponent(d.xUsername)}" target="_blank"`:''} title="X profile">\ud835\udd4a</a>
        </div>`).join('')}
      </div>
      ${!state.directory.length?`<div class="empty">No members yet.</div>`:''}
      <div class="muted" style="font-size:12px;margin-top:14px;"><span class="monetized-dot" style="margin:0 4px 0 0;"></span>Monetized member</div>
    </div>
  `;
}

const PAYOUT_TYPES = { premium:'\ud83c\udf1f Premium Award', bonus:'\ud83d\udcb5 Bonus', correction:'\u270f\ufe0f Correction', other:'\ud83d\udcdd Other' };

function openPayoutModal(opts){
  opts = opts || {};
  const editing = opts.editingPayoutId ? (state.payouts.scoped || []).find(p=>p.id===opts.editingPayoutId) : null;
  const members = allMembers().filter(m=>m.status==='active');
  let presetUserId = opts.presetUserId || (editing ? editing.userId : null);
  let presetType = opts.presetType || (editing ? editing.type : 'bonus');
  let winnerNote = '';
  if(presetType==='premium' && !editing){
    const wRank = weeklyLeaderboard(members.map(m=>m.id));
    const defaultWinner = wRank[0];
    if(defaultWinner && !presetUserId){ presetUserId = defaultWinner.userId; winnerNote = ' \u2014 this week\u2019s #1'; }
  }
  openModal(`
    <div class="modal">
      <h2>${editing?'Edit Payout':'Add Payout'}</h2>
      <div id="payoutWarnBox"></div>
      <form onsubmit="return submitPayout(event${editing?`,'${editing.id}'`:''})">
        <div class="field-row">
          <div class="field"><label>Type</label>
            <select id="pyType">
              ${Object.keys(PAYOUT_TYPES).map(k=>`<option value="${k}" ${presetType===k?'selected':''}>${PAYOUT_TYPES[k]}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Member</label>
            <select id="pyMember" ${editing?'disabled':''}>
              ${members.map(m=>`<option value="${m.id}" ${presetUserId===m.id?'selected':''}>${escapeHtml(m.displayName)}${presetUserId===m.id?winnerNote:''}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label>Amount ($, negative to correct down)</label><input id="pyAmount" type="number" step="0.01" value="${editing?editing.amount:0}" /></div>
          <div class="field"><label>Date</label><input id="pyDate" type="date" value="${editing?editing.date:dateStr(0)}" max="${dateStr(0)}" /></div>
        </div>
        <div class="check-row"><input type="checkbox" id="pyMonetized" ${editing?(editing.monetized?'checked':''):''} /> This is a real monetary payout (uncheck for a non-monetary badge/record)</div>
        <div class="field"><label>Note (optional)</label><input id="pyNote" placeholder="e.g. Week of Sep 22 winner" value="${editing?escapeHtml(editing.note||''):''}" /></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" style="width:auto;">${editing?'Save changes':'Add Payout'}</button>
        </div>
      </form>
    </div>
  `);
}

async function submitPayout(e, payoutId, override){
  e.preventDefault();
  const type = document.getElementById('pyType').value;
  const userId = document.getElementById('pyMember') ? document.getElementById('pyMember').value : null;
  const amount = document.getElementById('pyAmount').value;
  const monetized = document.getElementById('pyMonetized').checked;
  const date = document.getElementById('pyDate').value;
  const note = document.getElementById('pyNote').value.trim();
  try{
    if(payoutId){
      await apiSend('PUT', '/payouts/'+payoutId, { amount, monetized, type, note, date });
      toast('Payout updated.');
    }else{
      await apiSend('POST', '/payouts', { userId, amount, monetized, type, note, date, override: !!override });
      toast('Payout added.');
    }
    closeModal();
    await fetchState();
    render();
  }catch(err){
    if(err.data && err.data.error === 'cooldown_active'){
      const box = document.getElementById('payoutWarnBox');
      box.innerHTML = `<div class="login-error">This member already won Premium on ${escapeHtml(err.data.lastAwardedOn)} \u2014 not eligible again until ${escapeHtml(err.data.eligibleOn)} (once-a-month limit). <button type="button" class="btn btn-outline btn-sm" style="margin-top:8px;" onclick="submitPayout(event, ${payoutId?`'${payoutId}'`:null}, true)">Add anyway</button></div>`;
    }else{
      toast(err.message, true);
    }
  }
  return false;
}

function openAwardPremiumModal(){ openPayoutModal({ presetType:'premium' }); }

function payoutTypeLabel(type){
  if(type === 'community') return '🏦 Community Fund';
  return PAYOUT_TYPES[type] || escapeHtml(type);
}

/* ---- Manual top-up of the community total (not tied to any member) ---- */
function openFundModal(opts){
  opts = opts || {};
  const editing = opts.editingPayoutId ? (state.payouts.scoped || []).find(p=>p.id===opts.editingPayoutId) : null;
  openModal(`
    <div class="modal">
      <h2>${editing?'Edit Community Fund Entry':'Add to Community Funds'}</h2>
      <p class="muted" style="font-size:13px;margin-bottom:16px;">Adds straight to the Community Total — it isn't tied to any member and won't show in anyone's personal payouts.</p>
      <form onsubmit="return submitFund(event${editing?`,'${editing.id}'`:''})">
        <div class="field-row">
          <div class="field"><label>Amount ($, negative to correct down)</label><input id="fundAmount" type="number" step="0.01" required value="${editing?editing.amount:''}" placeholder="e.g. 100" /></div>
          <div class="field"><label>Date</label><input id="fundDate" type="date" value="${editing?editing.date:dateStr(0)}" max="${dateStr(0)}" /></div>
        </div>
        <div class="field"><label>Note (optional)</label><input id="fundNote" placeholder="e.g. Sponsor contribution" value="${editing?escapeHtml(editing.note||''):''}" /></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" style="width:auto;">${editing?'Save changes':'Add Funds'}</button>
        </div>
      </form>
    </div>
  `);
}

async function submitFund(e, payoutId){
  e.preventDefault();
  const amount = Number(document.getElementById('fundAmount').value);
  const date = document.getElementById('fundDate').value;
  const note = document.getElementById('fundNote').value.trim();
  if(!amount){ toast('Enter a non-zero amount.', true); return false; }
  try{
    if(payoutId){
      await apiSend('PUT', '/payouts/'+payoutId, { amount, note, date });
      toast('Community fund entry updated.');
    }else{
      await apiSend('POST', '/funds', { amount, note, date });
      toast(`$${amount.toFixed(2)} added to community funds.`);
    }
    closeModal();
    await fetchState();
    render();
  }catch(err){ toast(err.message, true); }
  return false;
}

async function deletePayout(e, payoutId){
  const btn = e.currentTarget;
  requireConfirm(btn, 'Delete', async () => {
    try{
      await apiSend('DELETE', '/payouts/'+payoutId);
      toast('Payout deleted.');
      await fetchState();
      render();
    }catch(err){ toast(err.message, true); }
  });
}

function renderPayoutsPage(u){
  if(u.role !== 'admin') return `<div class="empty">Not available.</div>`;
  const py = state.payouts;
  const list = py.scoped || [];
  return `
    <div class="page-head">
      <div><h1>\ud83d\udcb0 Payouts</h1><div class="sub">Community total, per-member history, and awards \u2014 everything here is admin-managed</div></div>
      <div class="toolbar">
        <button class="btn btn-outline btn-sm" style="width:auto;" onclick="openAwardPremiumModal()">\ud83c\udf1f Award Weekly Premium</button>
        <button class="btn btn-outline btn-sm" style="width:auto;" onclick="openFundModal()">+ Add Funds</button>
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="openPayoutModal()">+ Add Payout</button>
      </div>
    </div>
    <div class="grid-stats">
      ${communityTotalCardHtml(py, false)}
      <div class="stat-card">
        <div class="label">Last Premium Winner</div>
        ${py.lastPremiumWinner ? `<div class="value" style="font-size:16px;margin-top:6px;"${memberLinkAttrs(py.lastPremiumWinner.userId)}>\ud83c\udf1f ${escapeHtml(py.lastPremiumWinner.displayName)}</div><div class="muted" style="font-size:11.5px;">${fmtDate(py.lastPremiumWinner.date)}</div>` : `<div class="muted" style="margin-top:8px;">None yet</div>`}
      </div>
      <div class="stat-card"><div class="label">Total Records</div><div class="value">${list.length}</div></div>
    </div>
    <div class="card">
      <h3>All Payouts</h3>
      <div class="scrollx"><table class="to-cards"><thead><tr><th>Date</th><th>Member</th><th>Type</th><th>Amount</th><th>Note</th><th></th></tr></thead><tbody>
      ${list.map(p=>`<tr>
        <td data-label="Date">${fmtDate(p.date)}</td>
        <td data-label="Member"${p.type==='community'?'':memberLinkAttrs(p.userId)}>${escapeHtml(p.displayName)}</td>
        <td data-label="Type">${payoutTypeLabel(p.type)}</td>
        <td data-label="Amount"><span class="amt">$${(p.amount||0).toFixed(2)}</span> <span class="badge ${p.monetized?'monetized':'nonmonetized'}">${p.monetized?'Monetized':'Non-monetary'}</span></td>
        <td data-label="Note">${escapeHtml(p.note||'')}</td>
        <td data-label="">
          <button class="btn btn-outline btn-sm" onclick="${p.type==='community'?'openFundModal':'openPayoutModal'}({editingPayoutId:'${p.id}'})">Edit</button>
          <button class="btn btn-outline btn-sm" onclick="deletePayout(event,'${p.id}')">Delete</button>
        </td>
      </tr>`).join('')}
      ${!list.length?`<tr><td colspan="6"><div class="empty">No payouts recorded yet.</div></td></tr>`:''}
      </tbody></table></div>
    </div>
  `;
}

/* ===================== Part 11: Audit log ===================== */

function renderAuditLog(u){
  const logs = state.auditLogs;
  return `
    <div class="page-head"><div><h1>${u.role==='admin'?'Audit Logs':'Activity History'}</h1><div class="sub">${logs.length} entries</div></div></div>
    <div class="card">
      ${logs.length ? logs.map(l=>`<div class="history-item"><div class="dot"></div><div><div>${escapeHtml(l.action)}</div><div class="t">${escapeHtml(l.actor)} \u00b7 ${fmtDateTime(l.time)}</div></div></div>`).join('') : `<div class="empty">No history yet.</div>`}
    </div>
  `;
}

/* ===================== Part 12: Settings (admin only) ===================== */

function renderSettings(u){
  if(u.role !== 'admin') return `<div class="empty">Not available.</div>`;
  const s = state.settings;
  return `
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Community-wide configuration</div></div></div>
    <div class="card" style="max-width:460px;">
      <h3>General</h3>
      <form onsubmit="return saveSettings(event)">
        <div class="field"><label>Community name</label><input id="setName" value="${escapeHtml(s.communityName)}" /></div>
        <div class="field"><label>Timezone</label><input id="setTz" value="${escapeHtml(s.timezone)}" /></div>
        <button class="btn btn-primary" type="submit" style="margin-top:6px;">Save settings</button>
      </form>
    </div>
    <div class="card" style="max-width:460px;">
      <h3>How percentages work</h3>
      <p class="muted" style="font-size:13px;">Each member has an <b>assigned target %</b> (10\u2013100, set when they're added). Their daily "Today's Repost" is compared against that target and color-coded: green at or above target, orange just under it, red well under. A day's actual % comes from posts entered (calculated against that day's total community posts), a percentage set directly by admin/mod, or a CSV <code>repost_percentage</code> import \u2014 whichever was entered last always wins.</p>
    </div>
    <div class="card" style="max-width:460px;">
      <h3>Data</h3>
      <p class="muted" style="font-size:13px;margin-bottom:6px;">Everything (accounts, activity, audit history) is stored on the server in plain CSV files, in the <code>data/</code> folder next to <code>server.js</code>:</p>
      <p class="muted" style="font-size:12.5px;line-height:1.9;"><code>users.csv</code> \u00b7 <code>daily_activity.csv</code> \u00b7 <code>audit_logs.csv</code> \u00b7 <code>settings.json</code></p>
      <p class="muted" style="font-size:13px;margin-top:8px;">They're readable in Excel/Sheets and safe to back up by copying that folder. There's no in-app "erase everything" button on purpose \u2014 to fully reset, stop the server and delete the <code>data/</code> folder, then restart it (you'll land back on Setup).</p>
    </div>
  `;
}

async function saveSettings(e){
  e.preventDefault();
  const communityName = document.getElementById('setName').value.trim() || 'Simply Cloudy';
  const timezone = document.getElementById('setTz').value.trim() || 'Asia/Karachi';
  try{
    await apiSend('PUT', '/settings', { communityName, timezone });
    toast('Settings saved.');
    await fetchState();
    render();
  }catch(err){ toast(err.message, true); }
  return false;
}

/* ===================== Part 13: Boot ===================== */

function applyStoredTheme(){
  try{
    const t = localStorage.getItem(THEME_KEY);
    if(t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  }catch(e){}
}

document.addEventListener('DOMContentLoaded', async () => {
  applyStoredTheme();
  const root = document.getElementById('root');
  root.innerHTML = `<div class="login-screen"><div class="login-card" style="text-align:center;"><div class="login-brand" style="justify-content:center;"><span class="name">Bitbase<span class="brand-tag">community</span></span></div><div class="login-sub">Loading\u2026</div></div></div>`;
  try{
    await fetchState();
    render();
  }catch(err){
    root.innerHTML = `<div class="login-screen"><div class="login-card"><div class="login-brand"><span class="name">Bitbase<span class="brand-tag">community</span></span></div><div class="login-error">Could not reach the server. Is it running? (${escapeHtml(err.message)})</div><button class="btn btn-primary" onclick="location.reload()">Retry</button></div></div>`;
  }
});
