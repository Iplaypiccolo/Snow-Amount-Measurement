/* ============================================================
   관리 콘솔 (Supabase) — 로그인 · 비밀번호 변경 · 계정 관리 · 비밀번호 일괄 설정(엑셀표) · 접속 로그
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
  var S = { session: null, me: null, tab: 'users', sheet: null, users: null, hq: {}, br: {}, auditKind: '', vt: 0 };
  var ROLE = { admin: '관리자', branch: '피지원지사', equip: '지원장비' };

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
      '<label class="inline"><input type="checkbox" id="auto"> 자동 로그인 <span class="hint">(관리자 ' + A.AUTO_DAYS.admin + '일·그 외 ' + A.AUTO_DAYS.other + '일 유지) 공용 컴퓨터에서는 켜지 마세요</span></label>' +
      '<p><button class="primary" type="submit">로그인</button></p></form>' +
      '<p class="hint">임시 비밀번호로 처음 로그인하면 새 비밀번호를 정하게 됩니다.</p></div>';
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
    app.innerHTML = '<div class="card narrow"><h2>비밀번호 변경</h2>' + (forced ? '<p class="hint">임시 비밀번호로 로그인했습니다. <b>새 비밀번호를 정해야 계속 사용할 수 있습니다.</b></p>' : '') + '<div id="m"></div>' +
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
    var admin = S.me.role === 'admin';
    var tabs = admin ? [['users', '계정 관리'], ['sheet', '비밀번호 일괄 설정'], ['snow', '적설 자료'], ['audit', '접속 로그'], ['me', '내 정보']] : [['me', '내 정보']];
    if (!tabs.some(function (t) { return t[0] === S.tab; })) S.tab = tabs[0][0];
    S.vt++;                                   // 화면을 새로 그릴 때마다 번호표를 올려서, 이전 화면의 늦은 응답을 무시함
    app.innerHTML = '<div class="tabs" role="tablist">' + tabs.map(function (t) { return '<button role="tab" type="button" data-t="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div><div id="pane"></div>';
    Array.prototype.forEach.call(app.querySelectorAll('.tabs button'), function (b) { b.onclick = function () { if (S.tab === 'sheet' && b.dataset.t !== 'sheet' && sheetDirty() && !window.confirm('저장하지 않은 비밀번호 입력이 있습니다. 탭을 옮기면 사라집니다. 계속할까요?')) return; S.tab = b.dataset.t; if (b.dataset.t !== 'sheet') S.sheet = null; viewHome(); }; });
    ({ users: tabUsers, sheet: tabSheet, snow: tabSnow, audit: tabAudit, me: tabMe })[S.tab]();
  }
  var pane = function () { return $('pane'); };

  function tabMe() {
    var m = S.me;
    pane().innerHTML = '<div class="card"><h2>내 정보</h2><table><tr><th>아이디</th><td>' + esc(m.username) + '</td></tr><tr><th>이름</th><td>' + esc(m.display_name) + '</td></tr><tr><th>역할</th><td>' + esc(ROLE[m.role] || m.role) + (m.branch_id ? ' · ' + esc(m.branch_id) : '') + '</td></tr></table>' +
      '<p><button id="cp" type="button">비밀번호 변경</button></p>' + '<p><a href="../">← 첫 화면(강설량 측정·장비 지원)으로 가기</a></p>' + '</div>';
    $('cp').onclick = function () { viewChangePw(false); };
  }

  /* ---------- 공통: 계정·지사·본부 불러오기 ---------- */
  function loadDirectory() {
    return Promise.all([rest('profiles?select=id,username,display_name,role,branch_id,disabled,must_change&order=username'), rest('branches?select=id,name,hq_id&order=id'), rest('hqs?select=id,name,sort&order=sort')]).then(function (rs) {
      if (!rs[0].ok) throw new Error('profiles');
      S.users = rs[0].json || []; S.br = {}; S.hq = {};
      (rs[1].json || []).forEach(function (b) { S.br[b.id] = b; }); (rs[2].json || []).forEach(function (h) { S.hq[h.id] = h; });
    });
  }
  function hqName(u) { var b = S.br[u.branch_id]; return b && S.hq[b.hq_id] ? S.hq[b.hq_id].name : ''; }
  // 강설량 측정 화면과 같은 계층·순서: 본부(hqs.sort 순) → 그 안에서 지사 번호(B001, B002 … 가 곧 data/hierarchy.json 의 지사 순서) → 아이디.
  // 지사가 아닌 계정(지원장비)은 맨 아래 "지원장비·기타" 묶음.
  function hierInfo(u) {
    var b = S.br[u.branch_id], h = b && S.hq[b.hq_id];
    if (h) return { g: h.id, label: h.name, o1: h.sort, o2: b.id };
    return { g: '_other', label: '지원장비·기타', o1: 9999, o2: '' };
  }
  function cmpHier(a, b) {
    var x = hierInfo(a), y = hierInfo(b);
    return (x.o1 - y.o1) || (x.o2 < y.o2 ? -1 : x.o2 > y.o2 ? 1 : 0) || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0);
  }
  var ROLE_ORDER = { admin: 0, equip: 1, branch: 2 };

  /* ---------- 계정 관리 ---------- */
  function tabUsers() {
    var vt = S.vt;
    pane().innerHTML = '<div class="card"><h2>계정 관리</h2><div id="m"></div><div class="row"><input id="q" placeholder="아이디·이름·본부 검색" style="min-width:240px"><span class="hint" id="cnt"></span></div><div class="tw" id="list">불러오는 중…</div></div>';
    loadDirectory().then(function () { if (vt !== S.vt) return; drawUsers(); $('q').oninput = drawUsers; }).catch(function () { if (vt === S.vt && $('list')) $('list').innerHTML = msg('err', '계정 목록을 불러오지 못했습니다.'); });
  }
  function drawUsers() {
    var q = val('q').trim().toLowerCase(), rows = S.users.slice().sort(function (a, b) { return (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || cmpHier(a, b); }).filter(function (u) { return !q || (u.username + ' ' + u.display_name + ' ' + hqName(u)).toLowerCase().indexOf(q) >= 0; });
    $('cnt').textContent = rows.length + ' / ' + S.users.length + '개';
    $('list').innerHTML = '<table><thead><tr><th>아이디</th><th>이름</th><th>본부</th><th>역할</th><th>상태</th><th></th></tr></thead><tbody>' + rows.map(function (u) {
      var st = u.disabled ? '<span class="tag bad">비활성</span>' : u.must_change ? '<span class="tag warn">비밀번호 변경 대기</span>' : '<span class="tag ok">사용 중</span>', me = u.id === S.me.id;
      return '<tr><td>' + esc(u.username) + '</td><td>' + esc(u.display_name) + '</td><td>' + esc(hqName(u)) + '</td><td>' + esc(ROLE[u.role]) + '</td><td>' + st + '</td><td>' +
        '<button type="button" data-a="reset" data-u="' + esc(u.username) + '"' + (me ? ' disabled title="본인은 내 정보에서 바꾸세요"' : '') + '>임시 비밀번호 발급</button> ' +
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
    var vt = S.vt;
    pane().innerHTML = '<div class="card"><h2>비밀번호 일괄 설정</h2>' +
      '<p class="hint">지사·지원장비 계정의 비밀번호를 한 번에 정합니다. <b>저장한 비밀번호는 담당자가 그대로 계속 쓸 수 있습니다</b>(처음 로그인할 때 바꾸라고 요구하지 않음. 담당자가 원하면 \'내 정보\'에서 언제든 바꿀 수 있고, 관리자가 다시 정하면 그 비밀번호로 돌아갑니다). 표는 <b>강설량 측정 화면과 같은 본부·지사 순서</b>입니다(엑셀 목록을 같은 순서로 만들어 붙여넣으세요). <b>엑셀에서 비밀번호 열(또는 "아이디 + 비밀번호" 두 열)을 복사해 아무 입력칸에 붙여넣으세요.</b> 한 열만 붙여넣으면 눌러 둔 칸부터 아래로 채워지고, 두 열이면 아이디로 찾아 채웁니다. 관리자 계정은 이 표에 나오지 않습니다.</p>' +
      '<div id="m"></div><div class="row"><label class="inline"><input type="checkbox" id="rc"> 저장 후 처음 로그인할 때 본인이 비밀번호를 바꾸게 하기</label>' +
      '<label class="inline"><input type="checkbox" id="mk" checked> 입력한 비밀번호 가리기</label><input id="q" placeholder="본부·이름·아이디로 거르기" style="min-width:220px"></div>' +
      '<div class="row"><button type="button" id="rnd">빈 칸을 무작위 비밀번호로 채우기</button><button type="button" id="clr">입력 모두 지우기</button><button type="button" id="csv">입력한 비밀번호 CSV로 받기</button><span class="sp"></span><span id="sum" class="hint"></span><button type="button" class="primary" id="save" disabled>저장</button></div>' +
      '<div class="tw sheet" id="grid">불러오는 중…</div></div>';
    loadDirectory().then(function () {
      if (vt !== S.vt) return;
      var rows = S.users.filter(function (u) { return u.role !== 'admin'; }).sort(cmpHier).map(function (u) { var h = hierInfo(u); return { id: u.id, username: u.username, name: u.display_name, hq: hqName(u), g: h.g, gl: h.label, pw: '', state: '', note: '' }; });
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
        html += '<tr class="grp" data-g="' + esc(r.g) + '"><td colspan="6"><button type="button" class="gtoggle" data-g="' + esc(r.g) + '" aria-expanded="' + (!shut) + '" title="접기·펼치기">' + (shut ? '▸' : '▾') + '</button> <b>' + esc(r.gl) + '</b> <span class="hint">' + (r.g === '_other' ? '계정' : '지사') + ' ' + grp.length + '개 · 입력 <span class="gcnt">' + filled + '</span></span></td></tr>';
      }
      if (S.sheet.collapsed[r.g]) return;                 // 접어도 입력한 값과 붙여넣기 순서에는 영향이 없습니다(보이는 것만 숨김)
      var v = rowView(r, dups);
      html += '<tr class="' + v.cls + '" data-u="' + esc(r.username) + '" data-g="' + esc(r.g) + '"><td>' + n + '</td><td>' + esc(r.hq) + '</td><td>' + esc(r.name) + '</td><td class="mono">' + esc(r.username) + '</td><td class="cell"><input class="pw" type="' + type + '" autocomplete="new-password" spellcheck="false" data-u="' + esc(r.username) + '" value="' + esc(r.pw) + '"></td><td class="cell">' + v.html + '</td></tr>';
    });
    $('grid').innerHTML = '<table><thead><tr><th>#</th><th>본부</th><th>이름</th><th>아이디</th><th>새 비밀번호</th><th>검사</th></tr></thead><tbody>' + html + '</tbody></table>';
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
      '<p class="hint">기상청 API허브 콘솔 스크립트로 받은 <b>메모장(txt) 파일</b>을 올리면 서버에 저장되고, 모든 사용자의 "연도별 신적설" 표·지도에 바로 반영됩니다. ' +
      '먼저 <b>[검사]</b>로 새 값·바뀔 값 개수를 확인한 뒤 <b>[저장]</b>하세요. 결측(-99.9)과 시즌(11.15~3.15) 밖 날짜는 저장하지 않습니다.</p>' +
      '<div class="row"><input type="file" id="sf" accept=".txt,text/plain" multiple> <label class="inline"><input type="checkbox" id="sow"> 이미 있는 값과 다르면 바꾸기(덮어쓰기)</label></div>' +
      '<div class="row"><button type="button" id="splan">검사</button> <button type="button" id="sload" disabled>저장</button></div><div id="sm"></div>' +
      '<h3>예전 파일에서 처음 옮기기 (한 번만)</h3><p class="hint">저장소의 data/snow_data.json(2017~2026 시즌)을 서버로 옮깁니다. 이미 옮겼으면 "새 값 0"으로 나오며 다시 해도 바뀌지 않습니다.</p>' +
      '<div class="row"><button type="button" id="gplan">검사</button> <button type="button" id="gload">옮기기</button></div><div id="gm"></div>' +
      '<h3>최근 저장 기록</h3><div class="tw" id="sup">불러오는 중…</div></div>';
    function busy(on) { ['splan', 'sload', 'gplan', 'gload'].forEach(function (id) { if ($(id)) $(id).disabled = on || (id === 'sload' && !planned); }); }
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
    $('gplan').onclick = function () { run('gm', { action: 'plan', source: 'github', ref: 'main' }); };
    $('gload').onclick = function () {
      if (!window.confirm('예전 파일(data/snow_data.json)의 적설 자료를 서버로 옮길까요? 이미 있는 값은 그대로 둡니다.')) return;
      run('gm', { action: 'load', source: 'github', ref: 'main' }, function (r) { if (r.ok) loadUploads(); });
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
    pane().innerHTML = '<div class="card"><h2>접속·수정 로그</h2><div class="row"><label class="inline">구분 <select id="k"><option value="">전체</option><option>계정생성</option><option>비밀번호설정</option><option>비밀번호초기화</option><option>계정비활성화</option><option>계정활성화</option><option>수정</option><option>추가</option><option>삭제</option></select></label><button type="button" id="go">조회</button></div>' +
      '<p class="hint">기록은 서버가 남기며 이 화면에서 고치거나 지울 수 없습니다. 비밀번호는 기록되지 않습니다.</p><div class="tw" id="rows">불러오는 중…</div></div>';
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

  window.addEventListener('beforeunload', function (e) { if (sheetDirty()) { e.preventDefault(); e.returnValue = ''; } });
  logoutBtn.onclick = logout;
  window.AdminApp = { _state: function () { return S; } };
  start();
})();
