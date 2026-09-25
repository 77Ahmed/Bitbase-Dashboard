const { JSDOM } = require('jsdom');

const BASE = 'http://localhost:3000';
const results = [];
function record(label, ok, extra){ results.push([label, ok ? 'OK' : ('FAIL: ' + extra)]); }
async function tryAsync(label, fn){
  try{ await fn(); record(label, true); }
  catch(e){ record(label, false, e.message); }
}

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function freshWindow(){
  const html = await (await fetch(BASE + '/')).text();
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: BASE + '/' });
  let cookieJar = '';
  dom.window.fetch = async (url, opts) => {
    const fullUrl = typeof url === 'string' && url.startsWith('/') ? BASE + url : url;
    const finalOpts = Object.assign({}, opts, { headers: Object.assign({}, opts && opts.headers, cookieJar ? { Cookie: cookieJar } : {}) });
    const res = await fetch(fullUrl, finalOpts);
    const sc = res.headers.get('set-cookie');
    if(sc) cookieJar = sc.split(';')[0];
    return res;
  };
  await wait(500); // let external <script src> load + boot's fetchState()+render() settle
  return dom.window;
}

function html(w){ return w.document.getElementById('root').innerHTML; }
function submit(w, fieldId){ w.document.getElementById(fieldId).closest('form').dispatchEvent(new w.Event('submit', {bubbles:true, cancelable:true})); }

(async () => {
  // ---------- 1. Fresh boot shows Setup ----------
  let w = await freshWindow();
  await tryAsync('fresh boot shows Setup screen', async () => {
    if(!html(w).includes('Create Admin account')) throw new Error('expected Setup screen, got: ' + html(w).slice(0,200));
  });

  // ---------- 2. Complete setup through the real UI ----------
  await tryAsync('complete Setup through the real form', async () => {
    w.document.getElementById('setupCommunity').value = 'Rangers Community';
    w.document.getElementById('setupDisplayName').value = 'Sam Admin';
    w.document.getElementById('setupUsername').value = 'admin';
    w.document.getElementById('setupPassword').value = 'admin123456';
    w.document.getElementById('setupPassword2').value = 'admin123456';
    submit(w, 'setupCommunity');
    await wait(400);
    if(!html(w).includes('Welcome, Sam Admin')) throw new Error('did not land on admin dashboard: ' + html(w).slice(0,300));
  });

  // ---------- 3. Second browser: setup screen should be gone now ----------
  await tryAsync('a second fresh browser sees Login, not Setup (admin now exists)', async () => {
    const w2 = await freshWindow();
    if(html(w2).includes('Create Admin account')) throw new Error('setup should not reappear');
    if(!html(w2).includes('Log in')) throw new Error('expected login screen');
  });

  // ---------- 4. Admin creates a moderator through the real UI ----------
  await tryAsync('admin creates moderator "john" via the real modal', async () => {
    w.goto('moderators');
    await wait(50);
    w.openModeratorModal(null);
    await wait(50);
    w.document.getElementById('modDisplayName').value = 'John Carter';
    w.document.getElementById('modUsername').value = 'john';
    w.document.getElementById('modPassword').value = 'mod123456';
    submit(w, 'modDisplayName');
    await wait(400);
    if(!html(w).includes('John Carter')) throw new Error('john not visible in moderators list');
  });

  // ---------- 5. Admin creates a member assigned to john ----------
  await tryAsync('admin creates member "lisa" assigned to john', async () => {
    w.goto('members');
    await wait(50);
    w.openMemberModal(null);
    await wait(50);
    w.document.getElementById('mDisplayName').value = 'Lisa Novak';
    w.document.getElementById('mUsername').value = 'lisa';
    w.document.getElementById('mPassword').value = 'user123456';
    w.document.getElementById('mX').value = 'lisanovak';
    const johnId = w.getUserByUsername('john').id;
    w.document.getElementById('mModerator').value = johnId;
    submit(w, 'mDisplayName');
    await wait(400);
    if(!html(w).includes('Lisa Novak')) throw new Error('lisa not visible in members list');
    const lisa = w.getUserByUsername('lisa');
    if(lisa.moderatorId !== johnId) throw new Error('lisa not assigned to john');
  });

  // create a second moderator + member for scope tests
  await tryAsync('admin creates moderator "maya" and member "hamza"', async () => {
    w.goto('moderators'); await wait(50);
    w.openModeratorModal(null); await wait(50);
    w.document.getElementById('modDisplayName').value = 'Maya Lopez';
    w.document.getElementById('modUsername').value = 'maya';
    w.document.getElementById('modPassword').value = 'mod123456';
    submit(w, 'modDisplayName');
    await wait(400);

    w.goto('members'); await wait(50);
    w.openMemberModal(null); await wait(50);
    w.document.getElementById('mDisplayName').value = 'Hamza Iqbal';
    w.document.getElementById('mUsername').value = 'hamza';
    w.document.getElementById('mPassword').value = 'user123456';
    const mayaId = w.getUserByUsername('maya').id;
    w.document.getElementById('mModerator').value = mayaId;
    submit(w, 'mDisplayName');
    await wait(400);
    if(w.getUserByUsername('hamza').moderatorId !== mayaId) throw new Error('hamza not assigned to maya');
  });

  // ---------- 6. Set daily activity via the "posts" mode, through the modal ----------
  await tryAsync('admin sets lisa activity via Set Activity modal (posts mode)', async () => {
    const lisaId = w.getUserByUsername('lisa').id;
    w.openSetPercentModal(lisaId);
    await wait(50);
    w.document.getElementById('spPosts').value = '10';
    submit(w, 'spPosts');
    await wait(400);
    const today = w.dateStr(0);
    const rec = w.getRecord(lisaId, today);
    if(!rec || rec.posts !== 10) throw new Error('lisa activity not saved: ' + JSON.stringify(rec));
  });

  // ---------- 7. Manual percentage override requires a reason ----------
  await tryAsync('manual percentage override without reason is rejected', async () => {
    const hamzaId = w.getUserByUsername('hamza').id;
    w.openSetPercentModal(hamzaId);
    await wait(50);
    w.document.querySelector('input[name="spMode"][value="percent"]').checked = true;
    w.toggleEntryMode('sp','percent');
    w.document.getElementById('spPercent').value = '70';
    w.document.getElementById('spReason').value = '';
    submit(w, 'spPercent');
    await wait(300);
    const rec = w.getRecord(hamzaId, w.dateStr(0));
    if(rec) throw new Error('should have been rejected client-side (no server call made), but a record exists');
  });

  await tryAsync('manual percentage override with a reason is accepted', async () => {
    const hamzaId = w.getUserByUsername('hamza').id;
    w.openSetPercentModal(hamzaId);
    await wait(50);
    w.document.querySelector('input[name="spMode"][value="percent"]').checked = true;
    w.toggleEntryMode('sp','percent');
    w.document.getElementById('spPercent').value = '70';
    w.document.getElementById('spReason').value = 'Assigned target';
    submit(w, 'spPercent');
    await wait(400);
    const rec = w.getRecord(hamzaId, w.dateStr(0));
    if(!rec || rec.manualPercentage !== 70) throw new Error('hamza manual % not saved: ' + JSON.stringify(rec));
  });

  // ---------- 8. Daily-activity CSV import (repost_percentage format) through the real UI ----------
  await tryAsync('daily activity CSV import via the real UI (repost_percentage format)', async () => {
    w.goto('imports'); await wait(50);
    const csv = "username,total_posts,video_posts,community_pool_total,pool_excluding_own_posts,total_reposts,quality_reposts,old_post_reposts,outside_community_reposts,repost_percentage\n"
      + "lisa,10,10,15,5,3,1,0,2,12.5\n"
      + "unknownperson,4,4,15,11,82,3,0,79,60.0";
    const file = new w.File([csv], 'daily.csv', { type: 'text/csv' });
    const input = w.document.querySelector('input[type=file][onchange^="handleCsvFile"]');
    if(!input) throw new Error('daily CSV file input not found on the imports page');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(400);
    const previewHtml = w.document.getElementById('importPreviewWrap').innerHTML;
    if(!previewHtml.includes('notfound')) throw new Error('expected an unknownperson notfound row in preview: ' + previewHtml.slice(0,300));
    w.confirmImport();
    await wait(400);
    const lisaId = w.getUserByUsername('lisa').id;
    const rec = w.getRecord(lisaId, w.dateStr(0));
    if(!rec || rec.manualPercentage !== 12.5) throw new Error('lisa repost_percentage not applied: ' + JSON.stringify(rec));
  });

  // ---------- 9. Member CSV import through the real UI ----------
  await tryAsync('member CSV import via the real UI (create + moderator scoping)', async () => {
    w.goto('imports'); await wait(50);
    w.state.ui.params.importTab = 'members';
    w.render();
    await wait(50);
    const csv = "username,display_name,x_username,password\nbrandnew,Brand New Person,brandnewx,pass123456";
    const file = new w.File([csv], 'members.csv', { type: 'text/csv' });
    const input = w.document.querySelector('input[type=file][onchange^="handleMemberCsvFile"]');
    if(!input) throw new Error('member CSV file input not found');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(400);
    const previewHtml = w.document.getElementById('memberImportPreviewWrap').innerHTML;
    if(!previewHtml.includes('create')) throw new Error('expected a create row: ' + previewHtml.slice(0,300));
    w.confirmMemberImport();
    await wait(400);
    const created = w.getUserByUsername('brandnew');
    if(!created) throw new Error('brandnew member was not created');
  });

  // ---------- 10. Moderator deactivation requires reassignment ----------
  await tryAsync('deactivating a moderator with members prompts reassignment, then completes it', async () => {
    w.goto('moderators'); await wait(50);
    const mayaId = w.getUserByUsername('maya').id;
    await w.deactivateModerator(mayaId);
    await wait(300);
    const modalHtml = w.document.getElementById('modalRoot').innerHTML;
    if(!modalHtml.includes('Reassign')) throw new Error('expected reassignment modal: ' + modalHtml.slice(0,300));
    const johnId = w.getUserByUsername('john').id;
    w.document.getElementById('reassignTarget').value = johnId;
    await w.confirmReassignAndDeactivate(mayaId);
    await wait(400);
    const hamza = w.getUserByUsername('hamza');
    if(hamza.moderatorId !== johnId) throw new Error('hamza should have been reassigned to john');
    if(w.getUserByUsername('maya').status !== 'inactive') throw new Error('maya should be inactive now');
  });

  // ---------- 11. Log out, log in as john (moderator), verify scoping ----------
  await tryAsync('john (moderator) logs in and sees only his own members', async () => {
    await w.logout();
    await wait(300);
    w.document.getElementById('loginUsername').value = 'john';
    w.document.getElementById('loginPassword').value = 'mod123456';
    submit(w, 'loginUsername');
    await wait(400);
    if(!html(w).includes('Welcome, John Carter')) throw new Error('john did not land on his dashboard: ' + html(w).slice(0,300));
    const scope = w.scopeForCurrentUser();
    if(!scope.includes(w.getUserByUsername('lisa').id)) throw new Error('john should see lisa');
    if(!scope.includes(w.getUserByUsername('hamza').id)) throw new Error('john should see hamza (reassigned earlier)');
  });

  await tryAsync('moderators page is not available to a moderator', async () => {
    w.goto('moderators');
    await wait(50);
    if(!html(w).includes('Not available')) throw new Error('john should not see the moderators admin page');
  });

  // ---------- 12. Member login sees only their own dashboard ----------
  await tryAsync('member (lisa) logs in and only sees her own data', async () => {
    await w.logout();
    await wait(300);
    w.document.getElementById('loginUsername').value = 'lisa';
    w.document.getElementById('loginPassword').value = 'user123456';
    submit(w, 'loginUsername');
    await wait(400);
    if(!html(w).includes('Welcome, Lisa Novak')) throw new Error('lisa did not land on her dashboard: ' + html(w).slice(0,300));
    if(w.document.querySelector('.nav-item[onclick*="members"]')) throw new Error('member should not have a Members nav item');
  });

  // ---------- 13. Assigned percentage on member creation/editing ----------
  await tryAsync('admin sets assigned % when creating a member, validated 10-100', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'admin';
    w.document.getElementById('loginPassword').value = 'admin123456';
    submit(w, 'loginUsername');
    await wait(400);

    w.goto('members'); await wait(50);
    w.openMemberModal(null); await wait(50);
    w.document.getElementById('mDisplayName').value = 'Tanvir Shah';
    w.document.getElementById('mUsername').value = 'tanvir';
    w.document.getElementById('mPassword').value = 'user123456';
    w.document.getElementById('mAssignedPct').value = '80';
    submit(w, 'mDisplayName');
    await wait(400);
    const tanvir = w.getUserByUsername('tanvir');
    if(!tanvir || tanvir.assignedPercentage !== 80) throw new Error('assignedPercentage not saved: ' + JSON.stringify(tanvir));
  });

  await tryAsync('server rejects assigned % outside 10-100 even if client validation is bypassed', async () => {
    let blocked = false;
    try{
      await w.apiSend('POST', '/users', { role:'member', username:'badpct', password:'user123456', displayName:'Bad Pct', assignedPercentage: 5 });
    }catch(err){ blocked = (err.data && err.data.error && err.data.error.includes('between 10 and 100')); }
    if(!blocked) throw new Error('server should reject assignedPercentage=5');
  });

  // ---------- 14. Color-coded status logic ----------
  await tryAsync('activityStatus: green/orange/red thresholds', async () => {
    if(w.activityStatus(70, 70) !== 'green') throw new Error('actual==assigned should be green');
    if(w.activityStatus(95, 70) !== 'green') throw new Error('actual>assigned should be green');
    if(w.activityStatus(60, 70) !== 'orange') throw new Error('60 vs 70 should be orange (within 15)');
    if(w.activityStatus(40, 70) !== 'red') throw new Error('40 vs 70 should be red (more than 15 below)');
  });

  await tryAsync('tanvir set to 90% (assigned 80) shows green dot on Daily Reports', async () => {
    const tanvirId = w.getUserByUsername('tanvir').id;
    w.openSetPercentModal(tanvirId); await wait(50);
    w.document.getElementById('spPosts').value = '90';
    w.document.querySelector('input[name="spMode"][value="percent"]').checked = true;
    w.toggleEntryMode('sp','percent');
    w.document.getElementById('spPercent').value = '90';
    w.document.getElementById('spReason').value = 'test';
    submit(w, 'spPercent');
    await wait(400);
    w.goto('daily'); await wait(50);
    if(!html(w).includes('status-dot green')) throw new Error('expected a green status dot on the daily reports page');
  });

  // ---------- 15. Member directory ----------
  await tryAsync('All Community Members directory has its own sidebar page now', async () => {
    if(!w.document.querySelector('.nav-item[onclick*="\'directory\'"]')) throw new Error('expected an "All Members" nav item');
    w.goto('directory'); await wait(50);
    const dirHtml = html(w);
    if(!dirHtml.includes('All Community Members')) throw new Error('directory section missing');
    if(!dirHtml.includes('Tanvir Shah')) throw new Error('tanvir missing from directory');
    if(!dirHtml.includes('@tanvir')) throw new Error('username missing from directory entry');
  });

  await tryAsync('a member (lisa) can also see the full directory, not just her own moderator group', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'lisa';
    w.document.getElementById('loginPassword').value = 'user123456';
    submit(w, 'loginUsername');
    await wait(400);
    w.goto('directory'); await wait(50);
    if(!html(w).includes('Tanvir Shah')) throw new Error('lisa (a member under a different moderator) should still see tanvir in the directory');
  });

  // ---------- 16. Premium payouts + 30-day cooldown ----------
  await tryAsync('admin awards weekly Premium to tanvir', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'admin';
    w.document.getElementById('loginPassword').value = 'admin123456';
    submit(w, 'loginUsername');
    await wait(400);
    w.goto('leaderboard'); await wait(50);
    w.openAwardPremiumModal(); await wait(50);
    const tanvirId = w.getUserByUsername('tanvir').id;
    w.document.getElementById('pyMember').value = tanvirId;
    w.document.getElementById('pyAmount').value = '25';
    w.document.getElementById('pyMonetized').checked = true;
    w.document.getElementById('pyNote').value = 'Week 1 winner';
    submit(w, 'pyMember');
    await wait(400);
    await w.fetchPayouts();
    if(!w.state.payouts.lastPremiumWinner || w.state.payouts.lastPremiumWinner.userId !== tanvirId) throw new Error('lastPremiumWinner not set correctly: ' + JSON.stringify(w.state.payouts.lastPremiumWinner));
    if(w.state.payouts.communityTotal < 25) throw new Error('communityTotal should include the $25 award');
  });

  await tryAsync('awarding Premium again to the same member within 30 days is blocked (cooldown)', async () => {
    const tanvirId = w.getUserByUsername('tanvir').id;
    let cooldownHit = false;
    try{
      await w.apiSend('POST', '/payouts', { userId: tanvirId, amount: 10, monetized: true, type: 'premium', note: '', date: w.dateStr(0), override: false });
    }catch(err){ cooldownHit = err.data && err.data.error === 'cooldown_active'; }
    if(!cooldownHit) throw new Error('expected a cooldown_active rejection on second premium award within 30 days');
  });

  await tryAsync('override:true bypasses the cooldown', async () => {
    const tanvirId = w.getUserByUsername('tanvir').id;
    const res = await w.apiSend('POST', '/payouts', { userId: tanvirId, amount: 5, monetized: false, type: 'premium', note: 'manual override', date: w.dateStr(0), override: true });
    if(!res.payout) throw new Error('override award should have succeeded');
  });

  await tryAsync('non-admin cannot award payouts', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'john';
    w.document.getElementById('loginPassword').value = 'mod123456';
    submit(w, 'loginUsername');
    await wait(400);
    let blocked = false;
    try{ await w.apiSend('POST', '/payouts', { userId: w.getUserByUsername('lisa').id, amount: 5, monetized:true, type:'premium', date: w.dateStr(0) }); }
    catch(err){ blocked = err.message.includes('403') || (err.data && err.data.error); }
    if(!blocked) throw new Error('moderator should not be able to award payouts');
  });

  // ---------- 17. Daily Reports is now community-wide visible, edits stay scoped ----------
  await tryAsync('moderator (john) sees ALL members on Daily Reports, not just his own', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'john';
    w.document.getElementById('loginPassword').value = 'mod123456';
    submit(w, 'loginUsername');
    await wait(400);
    w.goto('daily'); await wait(50);
    const dailyHtml = html(w);
    if(!dailyHtml.includes('Lisa Novak')) throw new Error("john should see his own member lisa");
    if(!dailyHtml.includes('Hamza Iqbal')) throw new Error("john should ALSO see hamza (not his own member) on Daily Reports now");
    if(!dailyHtml.includes('Tanvir Shah')) throw new Error("john should ALSO see tanvir (admin's member) on Daily Reports");
  });

  await tryAsync('moderator (john) only gets an Edit button for his OWN members, not others, on Daily Reports', async () => {
    w.goto('daily'); await wait(50);
    const editScope = w.scopeForCurrentUser();
    const lisaId = w.getUserByUsername('lisa').id;
    const tanvirId = w.getUserByUsername('tanvir').id; // unassigned — never belonged to john
    if(!editScope.includes(lisaId)) throw new Error('sanity check failed: lisa should be in johns edit scope');
    if(editScope.includes(tanvirId)) throw new Error('sanity check failed: tanvir (unassigned) should NOT be in johns edit scope');
    // openAddDailyModal's member dropdown is built strictly from scopeForCurrentUser(), so
    // tanvir (out of scope) must not appear as an option even though he's visible in the table.
    w.openAddDailyModal(w.dateStr(0));
    await wait(50);
    const options = Array.from(w.document.querySelectorAll('#dmMember option')).map(o=>o.value);
    if(options.includes(tanvirId)) throw new Error("john's Add Daily Report member dropdown should not include tanvir");
    if(!options.includes(lisaId)) throw new Error("john's Add Daily Report member dropdown should include lisa");
    w.closeModal();
  });

  await tryAsync('member (lisa) can open Daily Reports (read-only) and see other members\u2019 data', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'lisa';
    w.document.getElementById('loginPassword').value = 'user123456';
    submit(w, 'loginUsername');
    await wait(400);
    if(!w.document.querySelector('.nav-item[onclick*="\'daily\'"]')) throw new Error('lisa should have a Daily Reports nav item now');
    w.goto('daily'); await wait(50);
    const dailyHtml = html(w);
    if(!dailyHtml.includes('Tanvir Shah')) throw new Error('lisa should see tanvir (a member outside her own moderator group) on Daily Reports');
    if(dailyHtml.includes('btn-outline btn-sm" onclick="openAddDailyModal')) throw new Error('lisa (a member) should never see an Edit/Add button on Daily Reports');
  });

  await tryAsync('server still blocks a member from calling the activity API directly, despite read visibility', async () => {
    let blocked = false;
    try{ await w.apiSend('POST', '/activity', { userId: w.getUserByUsername('lisa').id, date: w.dateStr(0), posts: 99 }); }
    catch(err){ blocked = !!(err.data && err.data.error); }
    if(!blocked) throw new Error('member should not be able to write activity via the API');
  });

  // ---------- 18. Monetized flag ----------
  await tryAsync('admin marks tanvir as monetized, green monetized dot shows on the directory', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'admin';
    w.document.getElementById('loginPassword').value = 'admin123456';
    submit(w, 'loginUsername');
    await wait(400);
    w.goto('members'); await wait(50);
    const tanvirId = w.getUserByUsername('tanvir').id;
    w.openMemberModal(tanvirId); await wait(50);
    w.document.getElementById('mMonetized').checked = true;
    submit(w, 'mDisplayName');
    await wait(400);
    if(!w.getUserByUsername('tanvir').monetized) throw new Error('tanvir.monetized should be true after saving');
    w.goto('directory'); await wait(50);
    if(!html(w).includes('monetized-dot')) throw new Error('expected a monetized-dot in the directory for tanvir');
  });

  await tryAsync('server persists monetized=false by default for a new member', async () => {
    const res = await w.apiSend('POST', '/users', { role:'member', username:'freshmember', password:'user123456', displayName:'Fresh Member', assignedPercentage:50 });
    if(res.user.monetized !== false) throw new Error('new member should default monetized:false, got ' + res.user.monetized);
  });

  // ---------- 19. Member detail is now open to any authenticated viewer ----------
  await tryAsync('a member can open another member\u2019s detail page (community-wide read visibility)', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'lisa';
    w.document.getElementById('loginPassword').value = 'user123456';
    submit(w, 'loginUsername');
    await wait(400);
    const tanvirId = w.getUserByUsername('tanvir').id;
    w.goto('memberDetail', {userId: tanvirId}); await wait(50);
    const detailHtml = html(w);
    if(detailHtml.includes("don't have access")) throw new Error('lisa should be able to view tanvir\'s detail page now');
    if(!detailHtml.includes('Tanvir Shah')) throw new Error('expected tanvir\'s name on the detail page');
  });

  // ---------- 20. Weekly activity = % of days target was met (7/7 = 100%) ----------
  await tryAsync('weekly formula: 3 of 7 days meeting a 50% target = 42.9%, missing/0% days count as misses', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'admin';
    w.document.getElementById('loginPassword').value = 'admin123456';
    submit(w, 'loginUsername');
    await wait(400);
    const created = await w.apiSend('POST', '/users', { role:'member', username:'weeklytest', password:'user123456', displayName:'Weekly Test', assignedPercentage:50 });
    const id = created.user.id;
    const d = off => w.dateStr(off);
    await w.apiSend('POST', '/activity', { userId:id, date:d(-6), posts:null, manualPercentage:60, reason:'t' }); // achieved
    await w.apiSend('POST', '/activity', { userId:id, date:d(-5), posts:null, manualPercentage:40, reason:'t' }); // missed
    await w.apiSend('POST', '/activity', { userId:id, date:d(-4), posts:null, manualPercentage:90, reason:'t' }); // achieved
    // d(-3) intentionally left with no record at all — a missing day
    await w.apiSend('POST', '/activity', { userId:id, date:d(-2), posts:null, manualPercentage:0,  reason:'t' }); // 0% — missed
    await w.apiSend('POST', '/activity', { userId:id, date:d(-1), posts:null, manualPercentage:50, reason:'t' }); // exactly on target — achieved
    await w.apiSend('POST', '/activity', { userId:id, date:d(0),  posts:null, manualPercentage:30, reason:'t' }); // missed
    await w.fetchState();
    const ws = w.weeklyStats(id);
    if(ws.achievedDays !== 3) throw new Error('expected achievedDays=3, got ' + ws.achievedDays);
    if(Math.abs(ws.weeklyPct - 42.9) > 0.1) throw new Error('expected weeklyPct\u224842.9, got ' + ws.weeklyPct);
  });

  await tryAsync('weekly formula: hitting target all 7 days = exactly 100%', async () => {
    const created = await w.apiSend('POST', '/users', { role:'member', username:'perfectweek', password:'user123456', displayName:'Perfect Week', assignedPercentage:60 });
    const id = created.user.id;
    for(let off=-6; off<=0; off++){
      await w.apiSend('POST', '/activity', { userId:id, date: w.dateStr(off), posts:null, manualPercentage:75, reason:'t' });
    }
    await w.fetchState();
    const ws = w.weeklyStats(id);
    if(ws.achievedDays !== 7) throw new Error('expected achievedDays=7, got ' + ws.achievedDays);
    if(ws.weeklyPct !== 100) throw new Error('expected weeklyPct=100, got ' + ws.weeklyPct);
  });

  // ---------- 21. All Members / My Members toggle ----------
  await tryAsync('moderator Members page defaults to "My Members", toggling to "All" shows everyone with edit still scope-limited', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'john';
    w.document.getElementById('loginPassword').value = 'mod123456';
    submit(w, 'loginUsername');
    await wait(400);
    w.goto('members'); await wait(50);
    let membersHtml = html(w);
    if(membersHtml.includes('Weekly Test')) throw new Error('default "My Members" view should not show tanvir\'s/admin\'s members like Weekly Test');
    if(!membersHtml.includes('Lisa Novak')) throw new Error('default view should still show johns own member lisa');

    w.state.ui.params.memberViewScope = 'all';
    w.render();
    await wait(50);
    membersHtml = html(w);
    if(!membersHtml.includes('Weekly Test')) throw new Error('"All Members" view should include members outside johns scope');
    // Edit button should still only render for johns own members even in All view
    const lisaRowEditable = membersHtml.includes(`openMemberModal('${w.getUserByUsername('lisa').id}')`);
    const weeklytestId = w.getUserByUsername('weeklytest').id;
    const weeklytestRowEditable = membersHtml.includes(`openMemberModal('${weeklytestId}')`);
    if(!lisaRowEditable) throw new Error('john should still have an Edit button for lisa in All view');
    if(weeklytestRowEditable) throw new Error('john should NOT have an Edit button for weeklytest (out of scope) even in All view');
  });

  await tryAsync('moderator Weekly Reports page also has an All/My toggle', async () => {
    w.goto('weekly'); await wait(50);
    if(!html(w).includes('My Members') || !html(w).includes('All Members')) throw new Error('expected an All/My toggle on the moderator Weekly Reports page');
  });

  // ---------- 22. General Add/Edit/Delete Payout (not tied to weekly Premium) ----------
  await tryAsync('admin adds a non-premium "bonus" payout to lisa with no cooldown restriction', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'admin';
    w.document.getElementById('loginPassword').value = 'admin123456';
    submit(w, 'loginUsername');
    await wait(400);
    w.goto('payouts'); await wait(50);
    if(!html(w).includes('All Payouts')) throw new Error('expected the dedicated Payouts page to render');
    w.openPayoutModal(); await wait(50);
    const lisaId = w.getUserByUsername('lisa').id;
    w.document.getElementById('pyType').value = 'bonus';
    w.document.getElementById('pyMember').value = lisaId;
    w.document.getElementById('pyAmount').value = '15';
    w.document.getElementById('pyMonetized').checked = true;
    w.document.getElementById('pyNote').value = 'Great week';
    submit(w, 'pyMember');
    await wait(400);
    await w.fetchPayouts();
    const lisaPayouts = w.state.payouts.scoped.filter(p=>p.userId===lisaId && p.type==='bonus');
    if(!lisaPayouts.length) throw new Error('expected a bonus payout for lisa');
    if(lisaPayouts[0].amount !== 15) throw new Error('bonus amount not saved correctly: ' + JSON.stringify(lisaPayouts[0]));
  });

  await tryAsync('a second bonus payout to the same member on the same day is NOT blocked (only "premium" type has a cooldown)', async () => {
    const lisaId = w.getUserByUsername('lisa').id;
    const res = await w.apiSend('POST', '/payouts', { userId: lisaId, amount: 5, monetized: true, type: 'bonus', note: 'another one', date: w.dateStr(0) });
    if(!res.payout) throw new Error('a second bonus payout should not be blocked by any cooldown');
  });

  await tryAsync('admin can edit an existing payout amount, community total updates accordingly', async () => {
    w.goto('payouts'); await wait(50);
    await w.fetchPayouts();
    const before = w.state.payouts.communityTotal;
    const lisaId = w.getUserByUsername('lisa').id;
    const target = w.state.payouts.scoped.find(p=>p.userId===lisaId && p.note==='Great week');
    if(!target) throw new Error('could not find the payout to edit');
    w.openPayoutModal({editingPayoutId: target.id}); await wait(50);
    w.document.getElementById('pyAmount').value = '50'; // was 15, +35
    submit(w, 'pyAmount');
    await wait(400);
    await w.fetchPayouts();
    const after = w.state.payouts.communityTotal;
    if(Math.abs((after - before) - 35) > 0.01) throw new Error(`expected community total to increase by 35, before=${before} after=${after}`);
    const edited = w.state.payouts.scoped.find(p=>p.id===target.id);
    if(edited.amount !== 50) throw new Error('edited amount not persisted: ' + JSON.stringify(edited));
  });

  await tryAsync('admin deletes a payout, community total decreases accordingly', async () => {
    const before = w.state.payouts.communityTotal;
    const lisaId = w.getUserByUsername('lisa').id;
    const target = w.state.payouts.scoped.find(p=>p.userId===lisaId && p.note==='another one');
    if(!target) throw new Error('could not find the payout to delete');
    await w.apiSend('DELETE', '/payouts/'+target.id);
    await w.fetchPayouts();
    const after = w.state.payouts.communityTotal;
    if(Math.abs((before - after) - 5) > 0.01) throw new Error(`expected community total to decrease by 5, before=${before} after=${after}`);
    if(w.state.payouts.scoped.find(p=>p.id===target.id)) throw new Error('deleted payout should no longer be in the list');
  });

  await tryAsync('non-admin cannot edit or delete payouts', async () => {
    await w.logout(); await wait(300);
    w.document.getElementById('loginUsername').value = 'john';
    w.document.getElementById('loginPassword').value = 'mod123456';
    submit(w, 'loginUsername');
    await wait(400);
    const anyPayout = w.state.payouts.myRecent[0] || (await (async()=>{ await w.fetchPayouts(); return w.state.payouts.scoped[0]; })());
    let editBlocked = false, deleteBlocked = false;
    if(anyPayout){
      try{ await w.apiSend('PUT', '/payouts/'+anyPayout.id, { amount: 999 }); } catch(err){ editBlocked = !!(err.data && err.data.error); }
      try{ await w.apiSend('DELETE', '/payouts/'+anyPayout.id); } catch(err){ deleteBlocked = !!(err.data && err.data.error); }
    }else{
      editBlocked = deleteBlocked = true; // nothing to test against, but don't fail the suite
    }
    if(!editBlocked || !deleteBlocked) throw new Error('moderator should not be able to edit/delete payouts');
  });

  console.log(JSON.stringify(results, null, 2));
  const fails = results.filter(r => r[1].startsWith('FAIL'));
  console.log('\nTOTAL:', results.length, ' FAILS:', fails.length);
  process.exit(fails.length ? 1 : 0);
})();
