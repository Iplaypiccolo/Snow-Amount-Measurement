/* ============================================================
   jurisdiction/requests.js — "구간 변경 요청" (지사 → 관리자)
   - 지사가 지도에서 구간을 골라 "다른 기관으로 옮겨 달라"고 요청하면 Supabase(jurisdiction_requests)에 저장됩니다.
   - 관리자가 로그인하면 처리 대기 요청이 있다는 알림창을 띄우고, 탭에 대기 개수를 표시합니다(1분마다 새로 확인).
   - 누가 무엇을 할 수 있는지는 서버(DB 권한)가 정합니다: 지사 계정만 요청, 자기 지사 요청만 읽기, 관리자만 승인·반려.
   ============================================================ */
(function (root) {
  'use strict';
  var T = 'jurisdiction_requests', POLL_MS = 60000, SEEN = 'jr_notice_seen';
  var W = { timer: null, opt: null, pendingMax: 0 };
  function A() { return root.SSAuth; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function fail(r, fallback) {
    var j = r && r.json || {}, code = j.code || '';
    if (code === '54000') return '처리 대기 중인 요청이 너무 많습니다(최대 20건). 관리자가 처리하거나 기존 요청을 취소한 뒤 다시 보내세요.';
    if (code === '42501' || r.status === 401 || r.status === 403) return '요청할 권한이 없습니다. 지사 계정으로 로그인했는지 확인하세요.';
    if (code === '23514') return '입력 내용이 규칙에 맞지 않습니다(구간 1~60개, 사유 200자 이내).';
    return fallback || '처리하지 못했습니다. 잠시 뒤에 다시 시도하세요.';
  }

  /* ---------- 서버 호출 ---------- */
  function list(query) {
    return A().rest(T + '?select=*&order=id.desc&limit=200' + (query || '')).then(function (r) { if (!r.ok) throw new Error('load'); return r.json || []; });
  }
  function create(p) {          // p: { sections:[{id,route,from,to,km,owner}], to, reason }
    var body = { section_ids: p.sections.map(function (s) { return s.id; }), snapshot: p.sections.map(function (s) { return { id: s.id, route: s.route, from: s.from, to: s.to, km: s.km, owner: s.owner || null }; }),
      to_branch_id: p.to || null, reason: (p.reason || '').trim() || null };
    return A().authed('/rest/v1/' + T, { method: 'POST', headers: { Prefer: 'return=representation' }, body: body }).then(function (r) {
      if (!r.ok) return { ok: false, message: fail(r, '요청을 보내지 못했습니다.') };
      return { ok: true, row: Array.isArray(r.json) ? r.json[0] : r.json };
    }).catch(function () { return { ok: false, message: A().NET_MSG }; });
  }
  function patch(filter, body) {
    return A().authed('/rest/v1/' + T + '?' + filter, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: body }).then(function (r) {
      if (!r.ok) return { ok: false, message: fail(r) };
      return { ok: true, rows: r.json || [] };
    }).catch(function () { return { ok: false, message: A().NET_MSG }; });
  }
  function cancel(id) { return patch('id=eq.' + encodeURIComponent(id), { status: 'cancelled' }); }
  function resolve(ids, status, note) {            // 관리자: 승인/반려
    ids = (ids || []).filter(function (x) { return /^\d+$/.test(String(x)); }); if (!ids.length) return Promise.resolve({ ok: true, rows: [] });
    var body = { status: status }; if (note) body.resolution_note = String(note).slice(0, 200);
    return patch('id=in.(' + ids.join(',') + ')&status=eq.pending', body);
  }

  /* ---------- 관리자 알림: 로그인했을 때 알림창 + 탭의 대기 개수 ---------- */
  function seen() { try { return parseInt(sessionStorage.getItem(SEEN) || '0', 10) || 0; } catch (e) { return 0; } }
  function markSeen(n) { try { sessionStorage.setItem(SEEN, String(n)); } catch (e) {} }
  function closeNotice() { var m = document.getElementById('jrNotice'); if (m) m.remove(); }
  function showNotice(rows, nameOf) {
    closeNotice();
    var by = {}, secs = {};
    rows.forEach(function (r) { by[r.branch_id] = (by[r.branch_id] || 0) + 1; secs[r.branch_id] = (secs[r.branch_id] || 0) + (r.section_ids || []).length; });
    var lines = Object.keys(by).sort().map(function (b) { return '<li><b>' + esc(nameOf(b)) + '</b> 요청 ' + by[b] + '건 <span>(구간 ' + secs[b] + '개)</span></li>'; }).join('');
    var m = document.createElement('div'); m.id = 'jrNotice'; m.className = 'jr-notice'; m.setAttribute('role', 'alertdialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'jrNoticeT');
    m.innerHTML = '<div class="jr-notice-card"><div class="jr-notice-ico" aria-hidden="true">🔔</div><h3 id="jrNoticeT">관할 노선 변경 요청이 있습니다</h3>' +
      '<p>처리를 기다리는 요청이 <b>' + rows.length + '건</b> 있습니다.</p><ul>' + lines + '</ul>' +
      '<div class="jr-notice-btns"><button type="button" class="jr-btn jr-primary" id="jrNoticeGo">확인하러 가기</button><button type="button" class="jr-btn" id="jrNoticeLater">나중에</button></div></div>';
    document.body.appendChild(m);
    document.getElementById('jrNoticeGo').focus();
    document.getElementById('jrNoticeGo').onclick = function () { closeNotice(); if (W.opt && W.opt.onOpen) W.opt.onOpen(); };
    document.getElementById('jrNoticeLater').onclick = closeNotice;
    m.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNotice(); });
  }
  function badge(n) {
    var b = document.querySelector('.tab-btn[data-tab=jurisdiction]'); if (!b) return;
    var old = b.querySelector('.jr-badge'); if (old) old.remove();
    if (n > 0) { var s = document.createElement('span'); s.className = 'jr-badge'; s.textContent = n; s.title = '처리 대기 중인 구간 변경 요청 ' + n + '건'; b.appendChild(s); }
  }
  function check(first) {
    if (document.visibilityState === 'hidden' && !first) return Promise.resolve();
    return list('&status=eq.pending').then(function (rows) {
      W.pendingMax = rows.reduce(function (m, r) { return Math.max(m, r.id); }, 0);
      badge(rows.length);
      if (W.opt && W.opt.onList) W.opt.onList(rows);
      if (rows.length && W.pendingMax > seen()) { markSeen(W.pendingMax); showNotice(rows, W.opt.nameOf || String); }
      return rows;
    }).catch(function () {});
  }
  // opt: { nameOf(branchId)→이름, onOpen(): 알림창의 [확인하러 가기], onList(rows): 대기 목록이 새로 왔을 때 }
  function startAdminWatch(opt) {
    if (!A() || !A().hasSession()) return; W.opt = opt || {};
    check(true); if (W.timer) clearInterval(W.timer); W.timer = setInterval(function () { check(false); }, POLL_MS);
  }
  function stop() { if (W.timer) clearInterval(W.timer); W.timer = null; badge(0); closeNotice(); }

  root.JurisRequests = { list: list, create: create, cancel: cancel, resolve: resolve, startAdminWatch: startAdminWatch, check: check, stop: stop, failText: fail, POLL_MS: POLL_MS };
})(window);
