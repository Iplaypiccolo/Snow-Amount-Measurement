/* ============================================================
   관리 콘솔 (Supabase) — 로그인 · 비밀번호 변경 · 계정 관리 · 산하기관 아이디 관리(비밀번호 일괄 설정·권한·새 아이디) · 적설 자료 · 접속 로그
   - 탭은 권한대로 보입니다: 계정 관리·산하기관 아이디 관리 = 관리자, 적설 자료 = snow.upload, 접속 로그 = log.view
   - 이 화면에는 비밀 키가 없습니다. 공개 키(publishable)만 쓰며, 무엇을 할 수 있는지는 서버(DB 권한 + 계정 발급 함수)가 매번 검사합니다.
   - 화면에서 버튼을 숨기는 것은 편의 기능이고, 권한은 서버가 지킵니다.
   - 입력한 비밀번호는 입력칸에만 있고, 저장하면 지우며, 어디에도(저장소·로그·주소) 남기지 않습니다.
   ============================================================ */
(function () {
  'use strict';
  var A = window.SSAuth;                  // 로그인 공통 부품(auth/auth.js)
  var P = window.PwPolicy;
  var $ = function (id) { return document.getElementById(id); };
  var app = $('app'), who = $('who'), logoutBtn = $('logoutBtn'), modal = $('modal');
  var S = { session: null, me: null, tab: 'users', sub: 'pw', sheet: null, users: null, hq: {}, br: {}, perms: [], orgs: [], auditKind: '', vt: 0, pm: null };
  var ROLE = { admin: '관리자', branch: '피지원지사', equip: '지원장비', hq: '지역본부', viewer: '보기 전용' };
  var can = function (p) { return A.can(S.me, p); };
  // 추천 산하기관 아이디(사용자 결정 2026-10-04): 지원장비 = 출발 기관별(지역 이름, 4글자면 앞 2글자 + gigyae), 지역본부 = 본부별 9개(지역 이름 전체)
  var PRESET = [
    { username: 'exseoulgigyae', display_name: '서울경기 지원장비', role: 'equip', org: '서울경기', sort: 10 },
    { username: 'exchungbukgigyae', display_name: '충북 지원장비', role: 'equip', org: '충북', sort: 20 },
    { username: 'exjeonbukgigyae', display_name: '전북 지원장비', role: 'equip', org: '전북', sort: 30 },
    { username: 'exdaegugigyae', display_name: '대구경북 지원장비', role: 'equip', org: '대구경북', sort: 40 },
    { username: 'exsudogwon', display_name: '수도권본부', role: 'hq', hq_id: 'H01' },
    { username: 'exseoulgyeonggi', display_name: '서울경기본부', role: 'hq', hq_id: 'H02' },
    { username: 'exgangwon', display_name: '강원본부', role: 'hq', hq_id: 'H03' },
    { username: 'exchungbuk', display_name: '충북본부', role: 'hq', hq_id: 'H04' },
    { username: 'exdaejeonchungnam', display_name: '대전충남본부', role: 'hq', hq_id: 'H05' },
    { username: 'exjeonbuk', display_name: '전북본부', role: 'hq', hq_id: 'H06' },
    { username: 'exgwangjujeonnam', display_name: '광주전남본부', role: 'hq', hq_id: 'H07' },
    { username: 'exdaegugyeongbuk', display_name: '대구경북본부', role: 'hq', hq_id: 'H08' },
    { username: 'exbusangyeongnam', display_name: '부산경남본부', role: 'hq', hq_id: 'H09' }
  ];

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function msg(kind, text) { return '<div class="msg ' + kind + '" role="status">' + esc(text) + '</div>'; }
  function val(id) { var e = $(id); return e ? e.value : ''; }
  function p2(n) { return String(n).padStart(2, '0'); }
  function fmt(iso) { if (!iso) return '-'; var d = new Date(iso); return isNaN(d) ? esc(iso) : d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }

  /* ---------- 서버와 통신: 공통 부품(auth/auth.js)이 로그인 토큰 보관·자동 갱신을 맡습니다 ---------- */
  var rest = A.rest, fn = A.fn, authed = A.authed, netErr = function () { return A.NET_MSG; };

  /* ---------- 시작 ---------- */
  function start() {
    if (!A.hasSession()) return viewLogin();
    loadMe().then(function (ok) { if (ok) route(); });
  }
  function loadMe() {
    return A.restore().then(function (r) {
      if (r.ok) { S.me = r.me; return true; }
      S.me = null; viewLogin(r.message); return false;
    });
  }
  function route() { header(); if (S.me.must_change) return viewChangePw(true); viewHome(); }
  function header() { who.textContent = S.me ? S.me.display_name + ' (' + (ROLE[S.me.role] || S.me.role) + ')' : ''; logoutBtn.hidden = !S.me; }

  /* ---------- 로그인 ---------- */
  function viewLogin(note) {
    S.me = null; header(); var saved = A.savedUser();
    app.innerHTML = '<div class="card narrow"><h2>로그인</h2>' + (note ? msg('warn', note) : '') + '<div id="m"></div><form id="f" autocomplete="on"><label>아이디<input id="u" autocomplete="username" autocapitalize="none" spellcheck="false" value="' + esc(saved) + '"></label>' +
      '<label>비밀번호<input id="pw" type="password" autocomplete="current-password"></label>' +
      '<label class="inline"><input type="checkbox" id="rem"' + (saved ? ' checked' : '') + '> 아이디 저장</label>' +
      '<label class="inline"><input type="checkbox" id="auto"> 자동 로그인</label>' +
      '<p><button class="primary" type="submit">로그인</button></p></form>' +
      '</div>';
    (saved ? $('pw') : $('u')).focus();
    $('f').onsubmit = function (e) {
      e.preventDefault(); var u = val('u').trim().toLowerCase(), pw = val('pw'); if (!u || !pw) { $('m').innerHTML = msg('err', '아이디와 비밀번호를 입력하세요.'); return; }
      A.login(u, pw, { remember: $('rem').checked, auto: $('auto').checked }).then(function (r) {
        if ($('pw')) $('pw').value = '';
        if (r.ok) { S.me = r.me; route(); return; }
        $('m').innerHTML = msg(r.reason === 'bad' ? 'err' : 'warn', r.message);   // 비밀번호 오류만 빨간색, 그 밖(미등록·비활성·연결 문제)은 안내색
      });
    };
  }
  function logout() { S.me = null; S.users = null; S.sheet = null; A.logout().then(function () { viewLogin(); }); }

  /* ---------- 비밀번호 변경 (임시 비밀번호면 반드시) ---------- */
  function viewChangePw(forced) {
    var u = S.me.username;
    app.innerHTML = '<div class="card narrow"><h2>비밀번호 변경</h2>' + '' + '<div id="m"></div>' +
      '<label>현재 비밀번호<input id="c" type="password" autocomplete="current-password"></label>' +
      '<label>새 비밀번호<input id="n" type="password" autocomplete="new-password"></label>' +
      '<ul class="checklist" id="chk"></ul>' +
      '<label>새 비밀번호 확인<input id="n2" type="password" autocomplete="new-password"></label>' +
      '<button class="primary" id="go" type="button">변경</button> ' + (forced ? '' : '<button id="bk" type="button">돌아가기</button>') + '</div>';
    var rules = [['12자 이상', /^[\s\S]{12,}$/], ['소문자', /[a-z]/], ['대문자', /[A-Z]/], ['숫자', /[0-9]/], ['기호(!@#$% 등)', null]];
    function check() {
      var pw = val('n'), prob = P.problems(pw, u);
      $('chk').innerHTML = rules.map(function (r, i) { var pass = i === 4 ? prob.indexOf('기호 필요') < 0 && pw.length > 0 : r[1].test(pw); return '<li class="' + (pass ? 'pass' : '') + '">' + r[0] + '</li>'; }).join('') +
        (prob.filter(function (x) { return !/12자|소문자|대문자|숫자|기호/.test(x); }).map(function (x) { return '<li style="color:#b3261e">' + esc(x) + '</li>'; }).join(''));
    }
    $('n').oninput = check; check();
    if (!forced) $('bk').onclick = viewHome;
    $('go').onclick = function () {
      var prob = P.problems(val('n'), u);
      if (prob.length) { $('m').innerHTML = msg('err', '새 비밀번호가 규칙에 맞지 않습니다: ' + prob.join(', ')); return; }
      if (val('n') !== val('n2')) { $('m').innerHTML = msg('err', '새 비밀번호 확인이 일치하지 않습니다.'); return; }
      if (val('n') === val('c')) { $('m').innerHTML = msg('err', '새 비밀번호는 현재 비밀번호와 달라야 합니다.'); return; }
      authed('/auth/v1/user', { method: 'PUT', body: { password: val('n'), current_password: val('c') } }).then(function (r) {
        if (!r.ok) { $('m').innerHTML = msg('err', (r.json && /current|incorrect|invalid/i.test(JSON.stringify(r.json))) ? '현재 비밀번호가 올바르지 않습니다.' : '비밀번호를 바꾸지 못했습니다. 규칙에 맞는지 확인하세요.'); return; }
        $('c').value = $('n').value = $('n2').value = '';
        return loadMe().then(function (ok) { if (!ok) return; header(); app.innerHTML = '<div class="card narrow">' + msg('ok', '비밀번호를 바꿨습니다.') + (S.me.must_change ? msg('warn', '아직 임시 상태로 표시됩니다. 다시 로그인해 보세요.') : '') + '<button class="primary" id="ok" type="button">계속</button></div>'; $('ok').onclick = route; });
      }).catch(function () { $('m').innerHTML = msg('err', netErr()); });
    };
  }

  /* ---------- 홈(탭) ---------- */
  function viewHome() {
    var admin = S.me.role === 'admin', tabs = [];
    if (admin) tabs.push(['users', '계정 관리'], ['sheet', '산하기관 아이디 관리']);
    if (can('snow.upload')) tabs.push(['snow', '적설 자료']);
    if (can('log.view')) tabs.push(['audit', '접속 로그']);
    tabs.push(['me', '내 정보']);
    if (!tabs.some(function (t) { return t[0] === S.tab; })) S.tab = tabs[0][0];
    S.vt++;                                   // 화면을 새로 그릴 때마다 번호표를 올려서, 이전 화면의 늦은 응답을 무시함
    app.innerHTML = '<div class="tabs" role="tablist">' + tabs.map(function (t) { return '<button role="tab" type="button" data-t="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div><div id="pane"></div>';
    Array.prototype.forEach.call(app.querySelectorAll('.tabs button'), function (b) { b.onclick = function () { if (S.tab === 'sheet' && b.dataset.t !== 'sheet' && (sheetDirty() || permDirty()) && !window.confirm('저장하지 않은 입력(비밀번호·권한)이 있습니다. 탭을 옮기면 사라집니다. 계속할까요?')) return; S.tab = b.dataset.t; if (b.dataset.t !== 'sheet') { S.sheet = null; S.pm = null; } viewHome(); }; });
    ({ users: tabUsers, sheet: tabSheet, snow: tabSnow, audit: tabAudit, me: tabMe })[S.tab]();
  }
  var pane = function () { return $('pane'); };

  function tabMe() {
    var m = S.me;
    pane().innerHTML = '<div class="card"><h2>내 정보</h2><table><tr><th>아이디</th><td>' + esc(m.username) + '</td></tr><tr><th>이름</th><td>' + esc(m.display_name) + '</td></tr><tr><th>역할</th><td>' + esc(ROLE[m.role] || m.role) + (m.branch_id || m.org || m.hq_id ? ' · ' + esc(m.branch_id || m.org || m.hq_id) : '') + '</td></tr>' +
      '<tr><th>권한</th><td>' + (m.role === 'admin' ? '관리자(모든 권한)' : esc((m.perms || []).join(', ') || '없음(보기만)')) + '</td></tr></table>' +
      '<p><button id="cp" type="button">비밀번호 변경</button></p>' + '<p><a href="../">← 첫 화면(강설량 측정·장비 지원)으로 가기</a></p>' + '</div>';
    $('cp').onclick = function () { viewChangePw(false); };
  }

  /* ---------- 공통: 계정·지사·본부 불러오기 ---------- */
  function loadDirectory() {
    return Promise.all([rest('profiles?select=id,username,display_name,role,branch_id,org,hq_id,perms,sort,disabled,must_change&order=username'), rest('branches?select=id,name,hq_id&order=id'), rest('hqs?select=id,name,sort&order=sort'),
      rest('permissions?select=key,label,description,default_roles&order=sort'), rest('equip_orgs?select=name')]).then(function (rs) {
      if (!rs[0].ok) throw new Error('profiles');
      S.users = rs[0].json || []; S.br = {}; S.hq = {}; S.perms = rs[3].json || [];
      var ORG_ORDER = ['서울경기', '충북', '전북', '대구경북'];
      S.orgs = (rs[4].json || []).map(function (o) { return o.name; }).sort(function (a, b) { var x = ORG_ORDER.indexOf(a), y = ORG_ORDER.indexOf(b); return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || (a < b ? -1 : 1); });
      (rs[1].json || []).forEach(function (b) { S.br[b.id] = b; }); (rs[2].json || []).forEach(function (h) { S.hq[h.id] = h; });
    });
  }
  function hqName(u) {
    if (u.role === 'hq') return S.hq[u.hq_id] ? S.hq[u.hq_id].name : '';
    if (u.role === 'equip') return u.org || '';
    var b = S.br[u.branch_id]; return b && S.hq[b.hq_id] ? S.hq[b.hq_id].name : '';
  }
  // 강설량 측정 화면과 같은 계층·순서: 본부(hqs.sort 순) → 그 안에서 지사 번호(B001, B002 … 가 곧 data/hierarchy.json 의 지사 순서) → 아이디.
  // 지역본부 계정은 그 본부 묶음의 맨 앞, 지원장비는 "지원장비(출발 기관)" 묶음, 보기 전용 등은 맨 아래 "기타" 묶음. 묶음 안 순서는 계정의 sort(○○ 다음) → 아이디.
  function srt(u) { return String(u.sort == null ? 99999 : u.sort).padStart(6, '0'); }
  function hierInfo(u) {
    var b = S.br[u.branch_id], h = u.role === 'hq' ? S.hq[u.hq_id] : b && S.hq[b.hq_id];
    if (h) return { g: h.id, label: h.name, o1: h.sort, o2: u.role === 'hq' ? ' ' + srt(u) : b.id };
    if (u.role === 'equip') return { g: '_equip', label: '지원장비(출발 기관)', o1: 9000, o2: srt(u) };
    return { g: '_other', label: '기타(보기 전용 등)', o1: 9999, o2: srt(u) };
  }
  function cmpHier(a, b) {
    var x = hierInfo(a), y = hierInfo(b);
    return (x.o1 - y.o1) || (x.o2 < y.o2 ? -1 : x.o2 > y.o2 ? 1 : 0) || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0);
  }
  var ROLE_ORDER = { admin: 0, hq: 1, equip: 2, branch: 3, viewer: 4 };

  /* ---------- 계정 관리 ---------- */
  function tabUsers() {
    var vt = S.vt;
    pane().innerHTML = '<div class="card"><h2>계정 관리</h2><div id="m"></div><div class="row"><input id="q" placeholder="아이디·이름·소속 검색" style="min-width:240px"><span class="hint" id="cnt"></span></div><div class="tw" id="list">불러오는 중…</div></div>';
    loadDirectory().then(function () { if (vt !== S.vt) return; drawUsers(); $('q').oninput = drawUsers; }).catch(function () { if (vt === S.vt && $('list')) $('list').innerHTML = msg('err', '계정 목록을 불러오지 못했습니다.'); });
  }
  function drawUsers() {
    var q = val('q').trim().toLowerCase(), rows = S.users.slice().sort(function (a, b) { return (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || cmpHier(a, b); }).filter(function (u) { return !q || (u.username + ' ' + u.display_name + ' ' + hqName(u)).toLowerCase().indexOf(q) >= 0; });
    $('cnt').textContent = rows.length + ' / ' + S.users.length + '개';
    $('list').innerHTML = '<table><thead><tr><th>아이디</th><th>이름</th><th>소속</th><th>역할</th><th>상태</th><th></th></tr></thead><tbody>' + rows.map(function (u) {
      var st = u.disabled ? '<span class="tag bad">비활성</span>' : u.must_change ? '<span class="tag warn">비밀번호 변경 대기</span>' : '<span class="tag ok">사용 중</span>', me = u.id === S.me.id;
      return '<tr><td>' + esc(u.username) + '</td><td>' + esc(u.display_name) + '</td><td>' + esc(hqName(u)) + '</td><td>' + esc(ROLE[u.role]) + '</td><td>' + st + '</td><td>' +
        '<button type="button" data-a="reset" data-u="' + esc(u.username) + '"' + (me ? ' disabled' : '') + '>임시 비밀번호 발급</button> ' +
        (u.disabled ? '<button type="button" data-a="enable" data-u="' + esc(u.username) + '">활성화</button>' : '<button type="button" class="danger" data-a="disable" data-u="' + esc(u.username) + '"' + (me ? ' disabled' : '') + '>비활성화</button>') + '</td></tr>';
    }).join('') + '</tbody></table>';
    Array.prototype.forEach.call($('list').querySelectorAll('button[data-a]'), function (b) { b.onclick = function () { userAction(b.dataset.a, b.dataset.u); }; });
  }
  function userAction(a, u) {
    if (a === 'reset' && !window.confirm(u + ' 계정에 새 임시 비밀번호를 발급할까요?\n지금의 비밀번호는 쓸 수 없게 되고, 이 계정의 로그인이 모두 끊깁니다.')) return;
    if (a === 'disable' && !window.confirm(u + ' 계정을 비활성화할까요? 즉시 로그아웃됩니다.')) return;
    fn({ action: a, username: u }).then(function (r) {
      var j = r.json || {};
      if (!r.ok || !j.ok) { if ($('m')) $('m').innerHTML = msg('err', j.message || '처리하지 못했습니다.'); return; }
      if (j.creds && j.creds[0]) showTemp(j.creds[0].username, j.creds[0].temp_password); else if ($('m')) $('m').innerHTML = msg('ok', '처리했습니다: ' + u);
      var vt = S.vt; return loadDirectory().then(function () { if (vt === S.vt && $('list')) drawUsers(); });
    }).catch(function () { if ($('m')) $('m').innerHTML = msg('err', netErr()); });
  }
  function showTemp(username, pw) {
    modal.hidden = false;
    modal.innerHTML = '<div class="dialog"><h3>임시 비밀번호 — ' + esc(username) + '</h3><p>이 비밀번호는 <b>지금 한 번만</b> 보입니다. 안전하게 전달하세요. 처음 로그인하면 새 비밀번호를 정하게 됩니다.</p><div class="temp" id="tmp">' + esc(pw) + '</div><div class="row"><button type="button" id="cp">복사</button><button type="button" class="primary" id="cl">닫기</button></div></div>';
    $('cp').onclick = function () { try { navigator.clipboard.writeText(pw); $('cp').textContent = '복사됨'; } catch (e) { var r = document.createRange(); r.selectNodeContents($('tmp')); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } };
    $('cl').onclick = function () { modal.hidden = true; modal.innerHTML = ''; };
  }

  /* ---------- 비밀번호 일괄 설정 (엑셀표) ---------- */
  function sheetDirty() { return !!(S.sheet && S.sheet.rows.some(function (r) { return r.pw; })); }
  function tabSheet() {
    var subs = [['pw', '비밀번호 일괄 설정'], ['perm', '권한·순서'], ['new', '새 아이디 만들기']];
    pane().innerHTML = '<div class="subtabs" role="tablist">' + subs.map(function (t) { return '<button role="tab" type="button" data-s="' + t[0] + '" class="' + (S.sub === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div><div id="sub"></div>';
    Array.prototype.forEach.call(pane().querySelectorAll('.subtabs button'), function (b) { b.onclick = function () {
      if (b.dataset.s === S.sub) return;
      if ((sheetDirty() || permDirty()) && !window.confirm('저장하지 않은 입력(비밀번호·권한)이 있습니다. 옮기면 사라집니다. 계속할까요?')) return;
      S.sub = b.dataset.s; S.sheet = null; S.pm = null; S.vt++; tabSheet();
    }; });
    ({ pw: subPasswords, perm: subPerms, 'new': subNew })[S.sub]();
  }
  var sub = function () { return $('sub'); };
  function subPasswords() {
    var vt = S.vt;
    sub().innerHTML = '<div class="card"><h2>비밀번호 일괄 설정</h2>' +
      '<div id="m"></div><div class="row"><label class="inline"><input type="checkbox" id="rc"> 저장 후 처음 로그인할 때 본인이 비밀번호를 바꾸게 하기</label>' +
      '<label class="inline"><input type="checkbox" id="mk" checked> 입력한 비밀번호 가리기</label><input id="q" placeholder="본부·이름·아이디로 거르기" style="min-width:220px"></div>' +
      '<div class="row"><button type="button" id="rnd">빈 칸을 무작위 비밀번호로 채우기</button><button type="button" id="clr">입력 모두 지우기</button><button type="button" id="csv">입력한 비밀번호 CSV로 받기</button><span class="sp"></span><span id="sum" class="hint"></span><button type="button" class="primary" id="save" disabled>저장</button></div>' +
      '<div class="tw sheet" id="grid">불러오는 중…</div></div>';
    loadDirectory().then(function () {
      if (vt !== S.vt) return;
      var rows = S.users.filter(function (u) { return u.role !== 'admin'; }).sort(cmpHier).map(function (u) { var h = hierInfo(u); return { id: u.id, username: u.username, name: u.display_name, hq: hqName(u), g: h.g, gl: h.label, kind: u.role, pw: '', state: '', note: '' }; });
      S.sheet = { rows: rows, collapsed: {} }; drawSheet(); bindSheet();
    }).catch(function () { if (vt === S.vt && $('grid')) $('grid').innerHTML = msg('err', '계정 목록을 불러오지 못했습니다.'); });
  }
  function visibleRows() { var q = val('q').trim().toLowerCase(); return S.sheet.rows.filter(function (r) { return !q || (r.hq + ' ' + r.name + ' ' + r.username).toLowerCase().indexOf(q) >= 0; }); }
  function dupMap() { var m = {}; S.sheet.rows.forEach(function (r) { if (r.pw) m[r.pw] = (m[r.pw] || 0) + 1; }); return m; }
  function rowProblems(r, dups) { if (!r.pw) return []; var p = P.problems(r.pw, r.username); if (!p.length && dups[r.pw] > 1) p.push('다른 계정과 같은 비밀번호'); return p; }
  function rowView(r, dups) {      // 한 줄의 색과 검사 문구
    var pr = rowProblems(r, dups);
    var cls = r.pw ? (pr.length ? 'bad' : 'good') : (r.state === 'saved' ? 'saved' : '');
    var st = r.pw ? (pr.length ? '<span class="why">' + esc(pr.join(', ')) + '</span>' : '<span class="okmark">✓</span>')
      : r.state === 'saved' ? '<span class="okmark">저장됨 ✓</span>' : '';
    if (r.note) st = '<span class="why">' + esc(r.note) + '</span>' + (r.pw && !pr.length ? ' <span class="okmark">(입력은 규칙 통과)</span>' : '');
    return { cls: cls, html: st };
  }
  function drawSheet() {
    var vis = visibleRows(), dups = dupMap(), type = $('mk').checked ? 'password' : 'text', html = '', last = null, n = 0;
    vis.forEach(function (r) {
      n++;
      if (r.g !== last) {
        last = r.g;
        var grp = vis.filter(function (x) { return x.g === r.g; }), filled = grp.filter(function (x) { return x.pw; }).length, shut = !!S.sheet.collapsed[r.g];
        html += '<tr class="grp" data-g="' + esc(r.g) + '"><td colspan="6"><button type="button" class="gtoggle" data-g="' + esc(r.g) + '" aria-expanded="' + (!shut) + '">' + (shut ? '▸' : '▾') + '</button> <b>' + esc(r.gl) + '</b> <span class="hint">계정 ' + grp.length + '개 · 입력 <span class="gcnt">' + filled + '</span></span></td></tr>';
      }
      if (S.sheet.collapsed[r.g]) return;                 // 접어도 입력한 값과 붙여넣기 순서에는 영향이 없습니다(보이는 것만 숨김)
      var v = rowView(r, dups);
      html += '<tr class="' + v.cls + '" data-u="' + esc(r.username) + '" data-g="' + esc(r.g) + '"><td>' + n + '</td><td>' + esc(r.hq) + '</td><td>' + esc(r.name) + '</td><td class="mono">' + esc(r.username) + '</td><td class="cell"><input class="pw" type="' + type + '" autocomplete="new-password" spellcheck="false" data-u="' + esc(r.username) + '" value="' + esc(r.pw) + '"></td><td class="cell">' + v.html + '</td></tr>';
    });
    $('grid').innerHTML = '<table><thead><tr><th>#</th><th>소속</th><th>이름</th><th>아이디</th><th>새 비밀번호</th><th>검사</th></tr></thead><tbody>' + html + '</tbody></table>';
    updateSummary();
  }
  function updateSummary() {
    var rows = S.sheet.rows, dups = dupMap(), filled = rows.filter(function (r) { return r.pw; }), bad = filled.filter(function (r) { return rowProblems(r, dups).length; });
    $('sum').textContent = '입력 ' + filled.length + '개' + (bad.length ? ' · 오류 ' + bad.length + '개' : '');
    $('save').disabled = !filled.length || !!bad.length; $('save').textContent = filled.length ? '저장 (' + filled.length + '개)' : '저장';
  }
  function refreshRows() {       // 입력 중에는 칸을 다시 그리지 않고 상태 표시만 갱신 (커서가 튀지 않게)
    var dups = dupMap();
    Array.prototype.forEach.call($('grid').querySelectorAll('tbody tr'), function (tr) {
      if (tr.classList.contains('grp')) { var c = S.sheet.rows.filter(function (x) { return x.g === tr.dataset.g && x.pw && visibleRows().indexOf(x) >= 0; }).length; tr.querySelector('.gcnt').textContent = c; return; }
      var r = S.sheet.rows.filter(function (x) { return x.username === tr.dataset.u; })[0], v = rowView(r, dups);
      tr.className = v.cls; tr.children[5].innerHTML = v.html;
    });
    updateSummary();
  }
  function bindSheet() {
    var g = $('grid');
    g.addEventListener('input', function (e) { var t = e.target; if (t.classList.contains('pw')) { var r = S.sheet.rows.filter(function (x) { return x.username === t.dataset.u; })[0]; r.pw = t.value; r.state = ''; r.note = ''; refreshRows(); } });   // 고친 칸만 "저장됨"·실패 이유를 지움
    g.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('.gtoggle'); if (t) { S.sheet.collapsed[t.dataset.g] = !S.sheet.collapsed[t.dataset.g]; drawSheet(); } });
    g.addEventListener('focusin', function (e) { if (e.target.classList.contains('pw')) S.sheet.focusUser = e.target.dataset.u; });
    g.addEventListener('paste', function (e) { var t = e.target; if (!t.classList.contains('pw')) return; var text = (e.clipboardData || window.clipboardData).getData('text'); if (text == null) return; e.preventDefault(); pasteText(text, t.dataset.u); });
    $('mk').onchange = drawSheet; $('q').oninput = drawSheet;
    $('clr').onclick = function () { if (sheetDirty() && !window.confirm('입력한 비밀번호를 모두 지울까요?')) return; S.sheet.rows.forEach(function (r) { r.pw = ''; r.state = ''; r.note = ''; }); $('m').innerHTML = ''; drawSheet(); };
    $('rnd').onclick = function () { var n = 0; visibleRows().forEach(function (r) { if (!r.pw) { r.pw = P.generate(r.username); n++; } }); $('m').innerHTML = n ? msg('ok', '빈 칸 ' + n + '개를 무작위 비밀번호로 채웠습니다. "CSV로 받기"로 내려받아 전달하세요.') : msg('warn', '채울 빈 칸이 없습니다.'); if (n) { $('mk').checked = false; } drawSheet(); };
    $('csv').onclick = downloadCsv; $('save').onclick = saveSheet;
  }
  function pasteText(text, startUser) {
    var lines = text.replace(/\r/g, '').split('\n'); while (lines.length && lines[lines.length - 1] === '') lines.pop(); if (!lines.length) return;
    var cells = lines.map(function (l) { return l.split('\t'); }), twoCols = cells.some(function (c) { return c.length >= 2; }), rows = S.sheet.rows, miss = [], n = 0;
    if (twoCols) {
      cells.forEach(function (c) { var u = (c[0] || '').trim().toLowerCase(), pw = (c[1] || '').trim(); if (!u && !pw) return; var r = rows.filter(function (x) { return x.username === u; })[0]; if (!r) { miss.push(u || '(빈 아이디)'); return; } r.pw = pw; r.state = ''; r.note = ''; n++; });
    } else {
      var vis = visibleRows(), at = Math.max(0, vis.findIndex(function (r) { return r.username === startUser; }));
      cells.forEach(function (c, i) { var r = vis[at + i]; if (!r) { miss.push('(행이 모자람 ' + (i + 1) + '번째)'); return; } r.pw = (c[0] || '').trim(); r.state = ''; r.note = ''; n++; });
    }
    $('m').innerHTML = msg(miss.length ? 'warn' : 'ok', n + '개 칸에 붙여넣었습니다.' + (miss.length ? '\n찾지 못한 항목: ' + miss.slice(0, 8).join(', ') + (miss.length > 8 ? ' 외 ' + (miss.length - 8) + '개' : '') : ''));
    drawSheet();
  }
  function downloadCsv() {
    var rows = S.sheet.rows.filter(function (r) { return r.pw; }); if (!rows.length) { $('m').innerHTML = msg('warn', '내려받을 비밀번호가 없습니다.'); return; }
    var q = function (v) { v = String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var text = '\uFEFF' + [['아이디', '이름', '비밀번호']].concat(rows.map(function (r) { return [r.username, r.name, r.pw]; })).map(function (l) { return l.map(q).join(','); }).join('\r\n') + '\r\n';
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = 'passwords.csv'; document.body.appendChild(a); a.click(); a.remove();
    $('m').innerHTML = msg('warn', 'passwords.csv 에는 비밀번호가 그대로 들어 있습니다. 전달한 뒤 바로 삭제하세요.');
  }
  function saveSheet() {
    var dups = dupMap(), items = S.sheet.rows.filter(function (r) { return r.pw; });
    if (!items.length || items.some(function (r) { return rowProblems(r, dups).length; })) return;
    if (!window.confirm(items.length + '개 계정의 비밀번호를 저장할까요?\n' + ($('rc').checked ? '각 계정은 처음 로그인할 때 비밀번호를 다시 정하게 됩니다.' : '저장한 비밀번호를 바로 쓰게 됩니다(처음 로그인할 때 바꾸라고 요구하지 않음).') + '\n이 계정들의 기존 로그인은 모두 끊깁니다.')) return;
    $('save').disabled = true; $('m').innerHTML = msg('warn', '저장하는 중…');
    var body = { action: 'set_passwords', require_change: $('rc').checked, items: items.map(function (r) { return { username: r.username, password: r.pw }; }) };
    fn(body).then(function (r) {
      var j = r.json || {};
      if (!$('grid')) { return; }                // 그 사이 다른 화면으로 옮겨 갔으면(저장은 서버에서 끝남) 화면은 건드리지 않음
      if (r.status === 400 && j.error === 'validation' && Array.isArray(j.details)) {
        j.details.forEach(function (d) { var it = items[d.index]; if (it) it.note = d.error; }); $('m').innerHTML = msg('err', '서버 검사에서 거절되었습니다. 표시된 줄을 고치세요.'); drawSheet(); return;
      }
      if (!r.ok && r.status !== 207) { $('m').innerHTML = msg('err', j.message || '저장하지 못했습니다.'); updateSummary(); return; }
      var failed = {}; (j.failed || []).forEach(function (f) { failed[f.username] = f.error; });
      var done = 0; items.forEach(function (it) { if (failed[it.username]) it.note = failed[it.username]; else { it.pw = ''; it.state = 'saved'; it.note = ''; done++; } });
      $('m').innerHTML = msg(Object.keys(failed).length ? 'warn' : 'ok', done + '개 저장했습니다.' + (Object.keys(failed).length ? '\n실패 ' + Object.keys(failed).length + '개는 표에 이유가 표시되어 있습니다.' : '') + (body.require_change ? '\n각 계정은 처음 로그인할 때 새 비밀번호를 정합니다.' : '\n담당자는 정한 비밀번호로 바로 로그인하고, 비밀번호를 바꾸라는 요구는 나오지 않습니다.'));
      drawSheet();
    }).catch(function () { $('m').innerHTML = msg('err', netErr()); updateSummary(); });
  }

  /* ---------- 산하기관 아이디 관리 > 권한·순서 ----------
     계정마다 켜고 끄는 권한(서버 표 permissions 목록 그대로). 관리자 계정은 모든 권한이라 표에 나오지 않습니다.
     묶음 줄의 칸을 누르면 그 묶음 계정 모두를 한꺼번에 켜거나 끕니다. 지사가 아닌 계정은 "위치(○○ 다음)"로 목록 순서를 정합니다. */
  function permDirty() { return !!(S.pm && S.pm.rows.some(function (r) { return r.dirty; })); }
  function samePerms(a, b) { return a.length === b.length && a.every(function (x) { return b.indexOf(x) >= 0; }); }
  function subPerms() {
    var vt = S.vt;
    sub().innerHTML = '<div class="card"><h2>권한·순서</h2>' +
      '<div id="m"></div><div class="row"><input id="q" placeholder="소속·이름·아이디로 거르기" style="min-width:220px"><span class="sp"></span><span id="psum" class="hint"></span><button type="button" id="prev">되돌리기</button><button type="button" class="primary" id="psave" disabled>저장</button></div><div class="tw sheet" id="pgrid">불러오는 중…</div></div>';
    loadDirectory().then(function () {
      if (vt !== S.vt) return;
      S.pm = { rows: S.users.filter(function (u) { return u.role !== 'admin'; }).sort(cmpHier).map(function (u) {
        var h = hierInfo(u); return { u: u, g: h.g, gl: h.label, perms: (u.perms || []).slice(), sort: u.sort, dirty: false };
      }) };
      drawPerms();
      $('q').oninput = drawPerms;
      $('prev').onclick = function () { if (permDirty() && !window.confirm('바꾼 권한·순서를 모두 되돌릴까요?')) return; S.pm.rows.forEach(function (r) { r.perms = (r.u.perms || []).slice(); r.sort = r.u.sort; r.dirty = false; }); $('m').innerHTML = ''; resortPerms(); drawPerms(); };
      $('psave').onclick = savePerms;
      $('pgrid').addEventListener('change', onPermChange);
      $('pgrid').addEventListener('click', onPermClick);
    }).catch(function () { if (vt === S.vt && $('pgrid')) $('pgrid').innerHTML = msg('err', '계정 목록을 불러오지 못했습니다.'); });
  }
  function markDirty(r) { r.dirty = !samePerms(r.perms, r.u.perms || []) || (r.sort == null ? null : r.sort) !== (r.u.sort == null ? null : r.u.sort); }
  function orderedGroup(g) { return S.pm.rows.filter(function (r) { return r.g === g && r.u.role !== 'branch'; }).sort(function (a, b) { return (a.sort == null ? 99999 : a.sort) - (b.sort == null ? 99999 : b.sort) || (a.u.username < b.u.username ? -1 : 1); }); }
  function drawPerms() {
    var q = val('q').trim().toLowerCase(), cols = S.perms, html = '', last = null;
    var vis = S.pm.rows.filter(function (r) { return !q || (hqName(r.u) + ' ' + r.u.display_name + ' ' + r.u.username).toLowerCase().indexOf(q) >= 0; });
    var head = '<tr><th>소속</th><th>이름</th><th>아이디</th><th>역할</th>' + cols.map(function (p) { return '<th class="pc">' + esc(p.label) + '</th>'; }).join('') + '<th>위치(순서)</th></tr>';
    vis.forEach(function (r) {
      if (r.g !== last) {
        last = r.g; var grp = vis.filter(function (x) { return x.g === r.g; });
        html += '<tr class="grp"><td colspan="4"><b>' + esc(r.gl) + '</b> <span class="hint">' + grp.length + '개</span></td>' + cols.map(function (p) {
          var on = grp.filter(function (x) { return x.perms.indexOf(p.key) >= 0; }).length;
          return '<td class="pc"><button type="button" class="gall" data-g="' + esc(r.g) + '" data-p="' + esc(p.key) + '">' + on + '/' + grp.length + '</button></td>';
        }).join('') + '<td></td></tr>';
      }
      var pos = '';
      if (r.u.role !== 'branch') {
        var og = orderedGroup(r.g), i = og.indexOf(r);
        pos = '<select class="pos" data-u="' + esc(r.u.username) + '"><option value=""' + (i === 0 ? ' selected' : '') + '>맨 앞</option>' + og.filter(function (x) { return x !== r; }).map(function (x) {
          return '<option value="' + esc(x.u.username) + '"' + (og[i - 1] === x ? ' selected' : '') + '>' + esc(x.u.display_name) + ' 다음</option>';
        }).join('') + '</select>';
      } else pos = '<span class="hint">지사 순서</span>';
      html += '<tr class="' + (r.dirty ? 'dirty' : '') + '"><td>' + esc(hqName(r.u)) + '</td><td>' + esc(r.u.display_name) + '</td><td class="mono">' + esc(r.u.username) + '</td><td>' + esc(ROLE[r.u.role] || r.u.role) + '</td>' +
        cols.map(function (p) { return '<td class="pc"><input type="checkbox" class="pchk" data-u="' + esc(r.u.username) + '" data-p="' + esc(p.key) + '"' + (r.perms.indexOf(p.key) >= 0 ? ' checked' : '') + '></td>'; }).join('') +
        '<td>' + pos + '</td></tr>';
    });
    $('pgrid').innerHTML = '<table class="perm"><thead>' + head + '</thead><tbody>' + (html || '<tr><td colspan="' + (cols.length + 5) + '" class="hint">계정이 없습니다.</td></tr>') + '</tbody></table>';
    var n = S.pm.rows.filter(function (r) { return r.dirty; }).length;
    $('psum').textContent = n ? '바꾼 계정 ' + n + '개' : ''; $('psave').disabled = !n; $('psave').textContent = n ? '저장 (' + n + '개)' : '저장';
  }
  function resortPerms() { var cu = function (r) { return Object.assign({}, r.u, { sort: r.sort }); }; S.pm.rows.sort(function (a, b) { return cmpHier(cu(a), cu(b)); }); }   // 바꾼 순서를 바로 보여 줌
  function rowOf(username) { return S.pm.rows.filter(function (r) { return r.u.username === username; })[0]; }
  function onPermChange(e) {
    var t = e.target;
    if (t.classList.contains('pchk')) {
      var r = rowOf(t.dataset.u), k = t.dataset.p;
      r.perms = t.checked ? r.perms.concat(r.perms.indexOf(k) >= 0 ? [] : [k]) : r.perms.filter(function (x) { return x !== k; });
      markDirty(r); drawPerms();
    } else if (t.classList.contains('pos')) {
      var me = rowOf(t.dataset.u), og = orderedGroup(me.g).filter(function (x) { return x !== me; }), at = t.value ? og.indexOf(rowOf(t.value)) + 1 : 0;
      og.splice(at, 0, me);
      og.forEach(function (x, i) { x.sort = (i + 1) * 10; markDirty(x); });          // 묶음 안 순서를 10, 20, 30 … 으로 다시 매김
      resortPerms(); drawPerms();
    }
  }
  function onPermClick(e) {
    var b = e.target.closest && e.target.closest('.gall'); if (!b) return;
    var q = val('q').trim().toLowerCase(), k = b.dataset.p;
    var grp = S.pm.rows.filter(function (r) { return r.g === b.dataset.g && (!q || (hqName(r.u) + ' ' + r.u.display_name + ' ' + r.u.username).toLowerCase().indexOf(q) >= 0); });
    var allOn = grp.every(function (r) { return r.perms.indexOf(k) >= 0; });
    grp.forEach(function (r) { r.perms = allOn ? r.perms.filter(function (x) { return x !== k; }) : r.perms.concat(r.perms.indexOf(k) >= 0 ? [] : [k]); markDirty(r); });
    drawPerms();
  }
  function savePerms() {
    var items = S.pm.rows.filter(function (r) { return r.dirty; }).map(function (r) {
      var it = { username: r.u.username };
      if (!samePerms(r.perms, r.u.perms || [])) it.perms = S.perms.map(function (p) { return p.key; }).filter(function (k) { return r.perms.indexOf(k) >= 0; });
      if ((r.sort == null ? null : r.sort) !== (r.u.sort == null ? null : r.u.sort)) it.sort = r.sort;
      return it;
    });
    if (!items.length || !window.confirm(items.length + '개 계정의 권한·순서를 저장할까요?\n바뀐 권한은 그 사람이 다음에 화면을 새로 열 때부터 적용되고, 서버 규칙에는 바로 적용됩니다.')) return;
    $('psave').disabled = true; $('m').innerHTML = msg('warn', '저장하는 중…');
    fn({ action: 'update', items: items }).then(function (r) {
      var j = r.json || {}; if (!$('pgrid')) return;
      if (!r.ok && r.status !== 207) { $('m').innerHTML = msg('err', j.message + (j.details ? '\n' + j.details.map(function (d) { return d.username + ': ' + d.error; }).join('\n') : '') || '저장하지 못했습니다.'); drawPerms(); return; }
      var failed = (j.failed || []).map(function (f) { return f.username + ': ' + f.error; });
      $('m').innerHTML = msg(failed.length ? 'warn' : 'ok', (j.updated || 0) + '개 계정을 저장했습니다.' + (failed.length ? '\n실패: ' + failed.join(', ') : ''));
      var vt = S.vt; return loadDirectory().then(function () { if (vt !== S.vt) return; S.pm.rows.forEach(function (r) { var u = S.users.filter(function (x) { return x.id === r.u.id; })[0]; if (u) { r.u = u; if (!failed.length || !failed.some(function (f) { return f.indexOf(u.username + ':') === 0; })) { r.perms = (u.perms || []).slice(); r.sort = u.sort; } } markDirty(r); }); resortPerms(); drawPerms(); });
    }).catch(function () { $('m').innerHTML = msg('err', netErr()); drawPerms(); });
  }

  /* ---------- 산하기관 아이디 관리 > 새 아이디 만들기 ----------
     관리자 계정은 만들지 않습니다. 비밀번호는 서버가 무작위 임시 비밀번호로 만들고 지금 한 번만 보여 줍니다(이후 "비밀번호 일괄 설정"에서 원하는 값으로 정함). */
  function defaultsFor(role) { return S.perms.filter(function (p) { return (p.default_roles || []).indexOf(role) >= 0; }).map(function (p) { return p.key; }); }
  function subNew() {
    var vt = S.vt;
    sub().innerHTML = '<div class="card"><h2>추천 산하기관 아이디</h2><div id="pm"></div><div class="tw" id="preset">불러오는 중…</div><p><button type="button" class="primary" id="mkpreset" disabled>없는 아이디 만들기</button></p></div>' +
      '<div class="card"><h2>새 아이디 하나 만들기</h2><div id="m"></div>' +
      '<div class="form2"><label>역할<select id="nrole"><option value="equip">지원장비(출발 기관)</option><option value="hq">지역본부</option><option value="viewer">보기 전용</option><option value="branch">피지원지사</option></select></label>' +
      '<label>소속<select id="nwhere"></select></label><label>아이디<input id="nuser" autocapitalize="none" spellcheck="false" placeholder="영문 소문자·숫자 (예: exseoulgigyae)"></label><label>이름<input id="nname" placeholder="예: 서울경기 지원장비"></label>' +
      '<label>위치(목록 순서)<select id="npos"></select><span class="hint" id="nposHint"></span></label></div><div id="nperms" class="permpick"></div><p><button type="button" class="primary" id="nmake">만들기</button></p></div>';
    loadDirectory().then(function () {
      if (vt !== S.vt) return;
      drawPreset(); fillNewForm();
      $('nrole').onchange = fillNewForm; $('nwhere').onchange = fillPos;
      $('nmake').onclick = makeOne; $('mkpreset').onclick = makePreset;
    }).catch(function () { if (vt === S.vt && $('preset')) $('preset').innerHTML = msg('err', '계정 목록을 불러오지 못했습니다.'); });
  }
  function presetWhere(p) { return p.role === 'equip' ? p.org : (S.hq[p.hq_id] ? S.hq[p.hq_id].name : p.hq_id); }
  function drawPreset() {
    var have = {}; S.users.forEach(function (u) { have[u.username] = u; });
    var missing = PRESET.filter(function (p) { return !have[p.username]; });
    $('preset').innerHTML = '<table><thead><tr><th>역할</th><th>소속</th><th>아이디</th><th>이름</th><th>기본 권한</th><th>상태</th></tr></thead><tbody>' + PRESET.map(function (p) {
      return '<tr><td>' + esc(ROLE[p.role]) + '</td><td>' + esc(presetWhere(p)) + '</td><td class="mono">' + esc(p.username) + '</td><td>' + esc(p.display_name) + '</td><td class="hint">' + esc(defaultsFor(p.role).join(', ')) + '</td><td>' + (have[p.username] ? '<span class="tag ok">있음</span>' : '<span class="tag warn">없음</span>') + '</td></tr>';
    }).join('') + '</tbody></table>';
    $('mkpreset').disabled = !missing.length; $('mkpreset').textContent = missing.length ? '없는 아이디 ' + missing.length + '개 만들기' : '모두 만들어져 있음';
  }
  function makePreset() {
    var have = {}; S.users.forEach(function (u) { have[u.username] = 1; });
    var users = PRESET.filter(function (p) { return !have[p.username]; }).map(function (p) { var o = {}; Object.keys(p).forEach(function (k) { o[k] = p[k]; }); return o; });
    if (!users.length || !window.confirm(users.length + '개 아이디를 만들까요?\n' + users.map(function (u) { return u.username; }).join(', ') + '\n임시 비밀번호는 무작위로 정해지고 지금 한 번만 보입니다.')) return;
    createUsers(users, 'pm', drawPreset);
  }
  function fillNewForm() {
    var role = val('nrole'), opts = role === 'equip' ? S.orgs.map(function (o) { return [o, o]; })
      : role === 'hq' ? Object.keys(S.hq).map(function (k) { return S.hq[k]; }).sort(function (a, b) { return a.sort - b.sort; }).map(function (h) { return [h.id, h.name]; })
      : role === 'branch' ? Object.keys(S.br).sort().map(function (k) { var b = S.br[k]; return [b.id, (S.hq[b.hq_id] ? S.hq[b.hq_id].name + ' · ' : '') + b.name + ' (' + b.id + ')']; }) : [];
    $('nwhere').innerHTML = opts.length ? opts.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'; }).join('') : '<option value="">(소속 없음)</option>';
    $('nwhere').disabled = !opts.length;
    var d = defaultsFor(role);
    $('nperms').innerHTML = '<div class="hint">권한</div>' + S.perms.map(function (p) { return '<label class="inline"><input type="checkbox" class="npc" value="' + esc(p.key) + '"' + (d.indexOf(p.key) >= 0 ? ' checked' : '') + '> ' + esc(p.label) + '</label>'; }).join('');
    fillPos();
  }
  function groupOfNew() { var role = val('nrole'), w = val('nwhere'); return role === 'equip' ? '_equip' : role === 'hq' ? w : role === 'branch' ? null : '_other'; }
  function fillPos() {
    var g = groupOfNew(), list = g ? S.users.filter(function (u) { return u.role !== 'admin' && u.role !== 'branch' && hierInfo(u).g === g; }).sort(cmpHier) : [];
    $('npos').innerHTML = g ? '<option value="">맨 앞</option>' + list.map(function (u, i) { return '<option value="' + esc(u.username) + '"' + (i === list.length - 1 ? ' selected' : '') + '>' + esc(u.display_name) + ' 다음</option>'; }).join('') : '<option value="">지사 순서(자동)</option>';
    $('npos').disabled = !g;
    // 같은 묶음(지원장비끼리 / 같은 본부의 지역본부 계정끼리 / 보기 전용 등)에 이미 있는 계정 사이에서 어디에 둘지. 비밀번호·권한 표에 나오는 순서
    $('nposHint').textContent = '';
  }
  function makeOne() {
    var role = val('nrole'), w = val('nwhere'), u = { username: val('nuser').trim().toLowerCase(), display_name: val('nname').trim(), role: role,
      perms: Array.prototype.filter.call(document.querySelectorAll('.npc'), function (c) { return c.checked; }).map(function (c) { return c.value; }) };
    if (role === 'equip') u.org = w; if (role === 'hq') u.hq_id = w; if (role === 'branch') u.branch_id = w;
    if (!/^[a-z0-9._-]{3,32}$/.test(u.username)) { $('m').innerHTML = msg('err', '아이디는 영문 소문자·숫자·. _ - 로 3~32자입니다.'); return; }
    if (!u.display_name) { $('m').innerHTML = msg('err', '이름을 입력하세요.'); return; }
    var g = groupOfNew(), reorder = [];
    if (g) {                                               // "○○ 다음" → 묶음 순서를 10, 20 … 으로 다시 매기고 새 계정을 그 자리에
      var list = S.users.filter(function (x) { return x.role !== 'admin' && x.role !== 'branch' && hierInfo(x).g === g; }).sort(cmpHier), after = val('npos');
      var at = after ? list.map(function (x) { return x.username; }).indexOf(after) + 1 : 0, seq = list.slice(); seq.splice(at, 0, { username: u.username, isNew: true });
      seq.forEach(function (x, i) { if (x.isNew) u.sort = (i + 1) * 10; else if (x.sort !== (i + 1) * 10) reorder.push({ username: x.username, sort: (i + 1) * 10 }); });
    }
    if (!window.confirm(u.username + ' (' + ROLE[role] + ') 아이디를 만들까요?\n임시 비밀번호는 무작위로 정해지고 지금 한 번만 보입니다.')) return;
    createUsers([u], 'm', function () { $('nuser').value = ''; $('nname').value = ''; fillPos(); }, reorder);
  }
  function createUsers(users, box, after, reorder) {
    $(box).innerHTML = msg('warn', '만드는 중…');
    fn({ action: 'create', users: users }).then(function (r) {
      var j = r.json || {};
      if (r.status === 400 && j.details) { $(box).innerHTML = msg('err', '입력을 확인하세요.\n' + j.details.map(function (d) { return (d.username || '') + ': ' + d.error; }).join('\n')); return; }
      if (r.status === 409) { $(box).innerHTML = msg('err', '이미 있는 아이디입니다: ' + (j.details || []).join(', ')); return; }
      if (!r.ok && r.status !== 207) { $(box).innerHTML = msg('err', j.message || '만들지 못했습니다.'); return; }
      $(box).innerHTML = msg((j.failed || []).length ? 'warn' : 'ok', (j.created || 0) + '개 아이디를 만들었습니다.' + ((j.failed || []).length ? '\n실패: ' + j.failed.map(function (f) { return f.username + '(' + f.error + ')'; }).join(', ') : ''));
      if (j.creds && j.creds.length) showTempList(j.creds);
      var next = reorder && reorder.length ? fn({ action: 'update', items: reorder }) : Promise.resolve();
      var vt = S.vt; return next.then(function () { return loadDirectory(); }).then(function () { if (vt === S.vt && after) after(); });
    }).catch(function () { $(box).innerHTML = msg('err', netErr()); });
  }
  function showTempList(creds) {
    modal.hidden = false;
    var csv = '\uFEFF' + [['아이디', '이름', '임시 비밀번호']].concat(creds.map(function (c) { return [c.username, c.display_name, c.temp_password]; })).map(function (l) { return l.join(','); }).join('\r\n') + '\r\n';
    modal.innerHTML = '<div class="dialog"><h3>임시 비밀번호 — ' + creds.length + '개</h3><p>이 비밀번호는 <b>지금 한 번만</b> 보입니다. 처음 로그인하면 새 비밀번호를 정하게 됩니다(또는 <b>비밀번호 일괄 설정</b>에서 관리자가 정할 수 있습니다).</p>' +
      '<div class="tw"><table><thead><tr><th>아이디</th><th>이름</th><th>임시 비밀번호</th></tr></thead><tbody>' + creds.map(function (c) { return '<tr><td class="mono">' + esc(c.username) + '</td><td>' + esc(c.display_name) + '</td><td class="temp">' + esc(c.temp_password) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<div class="row"><button type="button" id="dl">CSV로 받기</button><button type="button" class="primary" id="cl">닫기</button></div></div>';
    $('dl').onclick = function () { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = 'new-accounts.csv'; document.body.appendChild(a); a.click(); a.remove(); };
    $('cl').onclick = function () { modal.hidden = true; modal.innerHTML = ''; };
  }

  /* ---------- 접속 로그 ---------- */
  /* ---------- 적설 자료 (관리자 전용): 기상청 메모장 파일 → 서버(snow_daily) → 화면용 요약본 ----------
     서버 함수 import-snow 가 관리자 로그인을 다시 확인하고, 검사(plan) → 저장(load) 순서로 넣습니다. 결측(-99.9)·시즌 밖 날짜는 서버가 거릅니다. */
  function snowCall(body) {
    return authed('/functions/v1/import-snow', { method: 'POST', body: body }).then(function (r) { return { ok: r.ok, j: r.json || {} }; });
  }
  function snowSummary(j) {
    var c = j.counts || {}, s = j.summary || {}, d = s.dates || [];
    return (s.values != null ? '읽은 값 ' + s.values + '개 (관측소 ' + s.stations + '곳, ' + (d[0] || '?') + ' ~ ' + (d[1] || '?') + ')\n' : '') +
      '새 값 ' + (c['new'] || 0) + ' · 기존과 다른 값 ' + (c.changed || 0) + ' · 같은 값 ' + (c.same || 0) +
      ' · 결측(-99.9)이라 뺌 ' + (c.skipped_missing || 0) + ' · 시즌(11.15~3.15) 밖이라 뺌 ' + (c.skipped_out_of_season || 0) +
      (j.action === 'load' ? '\n저장한 값 ' + (c.written || 0) + '개' : '') + (j.message ? '\n' + j.message : '');
  }
  function tabSnow() {
    var vt = S.vt, txt = null, planned = null;
    pane().innerHTML = '<div class="card"><h2>적설 자료 (일 신적설)</h2>' +
      '<div class="row"><input type="file" id="sf" accept=".txt,text/plain" multiple> <label class="inline"><input type="checkbox" id="sow"> 이미 있는 값과 다르면 바꾸기(덮어쓰기)</label></div>' +
      '<div class="row"><button type="button" id="splan">검사</button> <button type="button" id="sload" disabled>저장</button></div><div id="sm"></div>' +
      '<h3>최근 저장 기록</h3><div class="tw" id="sup">불러오는 중…</div></div>';
    function busy(on) { ['splan', 'sload'].forEach(function (id) { if ($(id)) $(id).disabled = on || (id === 'sload' && !planned); }); }
    function readFiles() {
      var fs = $('sf').files; if (!fs || !fs.length) return Promise.reject(new Error('nofile'));
      return Promise.all(Array.prototype.map.call(fs, function (f) { return f.text(); })).then(function (ts) { return ts.join('\n'); });
    }
    function run(box, body, after) {
      busy(true); $(box).innerHTML = msg('warn', '서버에서 처리하는 중… (큰 파일은 1분 가까이 걸릴 수 있습니다)');
      return snowCall(body).then(function (r) {
        if (vt !== S.vt) return;
        $(box).innerHTML = msg(r.ok ? (r.j.counts && r.j.counts.changed && body.action === 'plan' ? 'warn' : 'ok') : 'err', r.ok ? snowSummary(r.j) : (r.j.message || '처리하지 못했습니다.'));
        if (after) after(r);
      }).catch(function () { if (vt === S.vt) $(box).innerHTML = msg('err', netErr()); }).then(function () { if (vt === S.vt) busy(false); });
    }
    $('sf').onchange = $('sow').onchange = function () { planned = null; txt = null; busy(false); $('sm').innerHTML = ''; };
    $('splan').onclick = function () {
      readFiles().then(function (t) { txt = t; return run('sm', { action: 'plan', txt: t, overwrite: $('sow').checked }, function (r) { planned = r.ok ? true : null; }); })
        .catch(function () { $('sm').innerHTML = msg('err', '메모장 파일을 먼저 고르세요.'); });
    };
    $('sload').onclick = function () {
      if (!planned || txt == null) return;
      if (!window.confirm('검사한 내용대로 서버에 저장할까요?' + ($('sow').checked ? '\n(덮어쓰기: 기존과 다른 값은 새 값으로 바뀝니다)' : ''))) return;
      run('sm', { action: 'load', txt: txt, overwrite: $('sow').checked }, function (r) { if (r.ok) { planned = null; loadUploads(); } });
    };
    function loadUploads() {
      rest('snow_uploads?select=at,date_from,date_to,stations,rows_written,ok,note&order=id.desc&limit=20').then(function (r) {
        if (vt !== S.vt || !$('sup')) return;
        if (!r.ok) { $('sup').innerHTML = msg('err', '불러오지 못했습니다.'); return; }
        $('sup').innerHTML = '<table><thead><tr><th>일시</th><th>기간</th><th>관측소</th><th>저장한 값</th><th>내용</th></tr></thead><tbody>' + ((r.json || []).map(function (x) {
          return '<tr><td>' + fmt(x.at) + '</td><td>' + esc((x.date_from || '?') + ' ~ ' + (x.date_to || '?')) + '</td><td>' + esc(x.stations) + '</td><td>' + esc(x.rows_written) + '</td><td>' + esc(x.note || '') + '</td></tr>';
        }).join('') || '<tr><td colspan="5" class="hint">아직 저장한 적이 없습니다.</td></tr>') + '</tbody></table>';
      }).catch(function () { if (vt === S.vt && $('sup')) $('sup').innerHTML = msg('err', netErr()); });
    }
    loadUploads();
  }

  function tabAudit() {
    var vt = S.vt;
    pane().innerHTML = '<div class="card"><h2>접속·수정 로그</h2><div class="row"><label class="inline">구분 <select id="k"><option value="">전체</option><option>계정생성</option><option>비밀번호설정</option><option>비밀번호초기화</option><option>계정비활성화</option><option>계정활성화</option><option>계정수정</option><option>수정</option><option>추가</option><option>삭제</option></select></label><button type="button" id="go">조회</button></div>' +
      '<div class="tw" id="rows">불러오는 중…</div></div>';
    $('k').value = S.auditKind;
    var load = function () {
      S.auditKind = val('k');
      rest('audit_log?select=id,at,username,role,kind,tab,target,ip&order=id.desc&limit=200' + (S.auditKind ? '&kind=eq.' + encodeURIComponent(S.auditKind) : '')).then(function (r) {
        if (vt !== S.vt || !$('rows')) return;
        if (!r.ok) { $('rows').innerHTML = msg('err', '불러오지 못했습니다.'); return; }
        $('rows').innerHTML = '<table><thead><tr><th>일시</th><th>아이디</th><th>구분</th><th>대상</th><th>IP</th></tr></thead><tbody>' + ((r.json || []).map(function (x) {
          return '<tr><td>' + fmt(x.at) + '</td><td>' + esc(x.username || '-') + '</td><td><span class="tag">' + esc(x.kind) + '</span></td><td>' + esc((x.tab ? x.tab + ' · ' : '') + (x.target || '')) + '</td><td class="mono">' + esc(x.ip || '') + '</td></tr>';
        }).join('') || '<tr><td colspan="5" class="hint">기록이 없습니다.</td></tr>') + '</tbody></table>';
      }).catch(function () { if (vt === S.vt && $('rows')) $('rows').innerHTML = msg('err', netErr()); });
    };
    $('go').onclick = load; load();
  }

  window.addEventListener('beforeunload', function (e) { if (sheetDirty() || permDirty()) { e.preventDefault(); e.returnValue = ''; } });
  logoutBtn.onclick = logout;
  window.AdminApp = { _state: function () { return S; } };
  start();
})();
