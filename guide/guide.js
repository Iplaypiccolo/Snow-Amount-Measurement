/* ============================================================
   guide/guide.js — 사용법 안내 (2026-10-30, 사용자 요청)
   - 로그인해서 강설량 측정이 처음 열리면 그 페이지 메뉴(탭)를 차례로 설명하고,
     장비 지원으로 처음 넘어가면 '지원 과정' 그림 → 탭 설명을 차례로 보여 줌. (계정별 권한 표는 2026-11-01 사용자 요청으로 뺌)
   - 오른쪽 아래 [다음](마지막은 [시작하기]) 또는 오른쪽 위 [설명 그만보기]로 닫음.
     한 번 닫으면 이 브라우저·이 아이디에서는 다시 저절로 나오지 않음(localStorage 'ss_guide:<페이지>:<아이디>', 사용자 결정 = 브라우저 기준).
   - 오른쪽 위 [사용법] 버튼을 누르면 지금 페이지의 안내를 처음부터 다시 봄.
   - 계정에 따라 보이는 탭만 설명하고, 탭마다 '내 계정이 할 일'을 한 줄 붙임(관리자 / 강원본부 / 다른 지역본부 / 지사 / 기계화부 / 보기 전용).
   - 자동 시험(브라우저 자동 조종) 중에는 저절로 열리지 않음(다른 시험의 클릭을 가리지 않게). 주소에 ?guide=auto 를 붙이면 시험에서도 열림.
   - 화면은 설명용이고 아무것도 저장하지 않음(이 브라우저의 '봤음' 표시만).
   ============================================================ */
(function (root) {
  'use strict';
  var doc = root.document;
  var KEY = 'ss_guide:';
  var AUTO = !root.navigator.webdriver || /[?&]guide=auto(&|$)/.test(root.location.search);
  var st = null, hqName = null, inited = false, waiting = {}, initP = Promise.resolve();

  function $(id) { return doc.getElementById(id); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function me() { return root.SS_ME || null; }
  function can(p) { return !!(root.SS_CAN && root.SS_CAN(p)); }
  function key(page) { var m = me(); return KEY + page + ':' + (m && m.username || '-'); }
  function seen(page) { try { return localStorage.getItem(key(page)) === '1'; } catch (e) { return false; } }
  function markSeen(page) { try { localStorage.setItem(key(page), '1'); } catch (e) {} }
  function curPage() { var s = $('shell'); return s && s.dataset.page === 'equip' ? 'equip' : 'snow'; }

  // 계정 구분: 지역본부 중 '강원'만 강원본부 지원장비 탭이 있음
  function roleKey() {
    var m = me(); if (!m) return 'viewer';
    if (m.role === 'hq') return hqName === '강원' ? 'gw' : 'hq';
    return m.role === 'admin' || m.role === 'branch' || m.role === 'equip' ? m.role : 'viewer';
  }
  var ROLE = { admin: '관리자 (재난처·교통처)', gw: '강원본부', hq: '지역본부', branch: '지사', equip: '기계화부', viewer: '보기 전용' };

  /* ---------------- 내용 ---------------- */

  /* 지원 과정 그림(SVG) — 넓은 화면은 가로, 좁은 화면은 세로. 두 흐름이 '교통처 배정'에서 하나로 합쳐짐 */
  var FLOW = {
    A1: { who: '지사', title: '지원 요청', sub: ['요청 대수 · 도착 요청 시각'], tab: '지사별 요청·편성', c: 'cy', roles: ['branch', 'hq', 'gw'] },
    A2: { who: '재난처', title: '승인', sub: ['편성 대수 확정'], tab: '지사별 요청·편성', c: 'vi', roles: ['admin'] },
    B1: { who: '기계화부 · 지사', title: '지원 가능 대수 확인', sub: ['기계화부: 장비 지원 여부', '지사: 타지사 지원 가능 대수'], tab: '기관별 장비 · 요청·편성', c: 'te', roles: ['equip', 'branch', 'hq', 'gw'] },
    M: { who: '교통처', title: '배정', sub: ['어느 기관이', '어느 지사에 몇 대'], tab: '기관별 배정', c: 'bl', roles: ['admin'], merge: true },
    N: { who: '기계화부', title: '장비 지정 · 도착 시간', sub: ['보낼 장비 ·', '도착 예상 시각'], tab: '기관별 장비', c: 'te', roles: ['equip'] },
    E: { who: '모든 계정', title: '이동 현황', sub: ['어디로 몇 대가', '언제 도착하는지'], tab: '이동 현황', c: 'em' },
    G: { who: '강원본부', title: '강원 신속대응팀 직접 지원', sub: ['요청·승인·배정과 상관없이 보냄', '제설차 4대 (원주·홍천·대관령·강릉)'], tab: '강원본부 지원장비', c: 'am', roles: ['gw'], dashed: true }
  };
  var LAYOUT = {
    h: { w: 960, h: 412, pos: { A1: [10, 30, 172, 108], A2: [206, 30, 172, 108], B1: [10, 166, 368, 108], M: [432, 98, 172, 108], N: [628, 98, 172, 108], E: [824, 98, 128, 108], G: [10, 302, 368, 100] },
      links: [['A1A2', 'M182,84 H204'], ['A2M', 'M378,84 C405,84 405,140 430,140'], ['B1M', 'M378,220 C405,220 405,164 430,164'], ['MN', 'M604,152 H626'], ['NE', 'M800,152 H822'], ['GE', 'M378,352 H888 V208', 'g']],
      labels: [[10, 20, '① 요청 → 승인'], [10, 157, '② 지원 가능 대수 확인'], [10, 293, '③ 강원본부 별도'], [518, 80, '합류', 'mid']] },
    v: { w: 360, h: 848, pos: { A1: [10, 30, 166, 108], A2: [10, 170, 166, 108], B1: [184, 30, 166, 248], M: [70, 324, 220, 108], N: [70, 464, 220, 108], E: [70, 604, 220, 100], G: [10, 742, 340, 100] },
      links: [['A1A2', 'M93,138 V168'], ['A2M', 'M93,278 C93,302 150,300 150,322'], ['B1M', 'M267,278 C267,302 210,300 210,322'], ['MN', 'M180,432 V462'], ['NE', 'M180,572 V602'], ['GE', 'M180,742 V706', 'g']],
      labels: [[10, 20, '① 요청 → 승인'], [184, 20, '② 지원 가능'], [10, 734, '③ 강원본부 별도'], [180, 307, '합류', 'mid']] }
  };
  function flowSvg(kind) {
    var L = LAYOUT[kind], rk = roleKey(), id = 'sgA' + kind;
    var s = '<svg class="sg-flow ' + kind + '" viewBox="0 0 ' + L.w + ' ' + L.h + '" role="img" aria-label="장비 지원 과정: 지사 요청, 재난처 승인과 기계화부·지사 지원 가능 대수 확인이 교통처 배정으로 합쳐지고, 기계화부 장비 지정·도착 시간을 거쳐 이동 현황. 강원본부 신속대응팀은 따로 이동 현황으로.">' +
      '<defs><marker id="' + id + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="sg-ah"/></marker>' +
      '<marker id="' + id + 'g" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="sg-ah g"/></marker>' +
      '<linearGradient id="' + id + 'm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ee7ff"/><stop offset=".55" stop-color="#6d8bff"/><stop offset="1" stop-color="#b48cff"/></linearGradient></defs>';
    L.labels.forEach(function (t) { s += '<text class="sg-lane' + (t[3] ? ' ' + t[3] : '') + '" x="' + t[0] + '" y="' + t[1] + '"' + (t[3] === 'mid' ? ' text-anchor="middle"' : '') + '>' + esc(t[2]) + '</text>'; });
    L.links.forEach(function (k) { s += '<path class="sg-link' + (k[2] ? ' g' : '') + '" d="' + k[1] + '" marker-end="url(#' + id + (k[2] ? 'g' : '') + ')"/>'; });
    Object.keys(L.pos).forEach(function (n) {
      var p = L.pos[n], d = FLOW[n], x = p[0], y = p[1], w = p[2], hh = p[3], cx = x + w / 2, mine = (d.roles || []).indexOf(rk) >= 0;
      var lines = 18 + 8 + 18 + 4 + d.sub.length * 15 + 19, ty = y + (hh - lines) / 2;
      s += '<g class="sg-node ' + d.c + (d.merge ? ' merge' : '') + (d.dashed ? ' dashed' : '') + (mine ? ' me' : '') + '">' +
        '<rect class="sg-box" x="' + x + '" y="' + y + '" width="' + w + '" height="' + hh + '" rx="14"' + (d.merge ? ' stroke="url(#' + id + 'm)"' : '') + '/>';
      var cw = Math.max(46, d.who.length * 11 + 18);
      s += '<rect class="sg-chip" x="' + (cx - cw / 2) + '" y="' + ty + '" width="' + cw + '" height="18" rx="9"/><text class="sg-who" x="' + cx + '" y="' + (ty + 13) + '" text-anchor="middle">' + esc(d.who) + '</text>';
      s += '<text class="sg-t" x="' + cx + '" y="' + (ty + 26 + 15) + '" text-anchor="middle">' + esc(d.title) + '</text>';
      d.sub.forEach(function (t, i) { s += '<text class="sg-s" x="' + cx + '" y="' + (ty + 48 + 12 + i * 15) + '" text-anchor="middle">' + esc(t) + '</text>'; });
      s += '<text class="sg-tab" x="' + cx + '" y="' + (ty + lines - 3) + '" text-anchor="middle">' + esc(d.tab) + ' 탭</text>';
      if (mine) s += '<rect class="sg-me" x="' + (x + w - 52) + '" y="' + (y - 9) + '" width="56" height="18" rx="9"/><text class="sg-me-t" x="' + (x + w - 24) + '" y="' + (y + 4) + '" text-anchor="middle">내 역할</text>';
      s += '</g>';
    });
    return s + '</svg>';
  }
  function processHtml() {
    return '<div class="sg-flow-box">' + flowSvg('h') + flowSvg('v') + '</div>' +
      '<div class="sg-notes">' +
      '<div class="sg-note am"><span class="sg-note-ic" aria-hidden="true">!</span><div><b>강원본부 신속대응팀</b><br>요청·승인·배정 없이 직접 지원 → 이동 현황에만 합산</div></div>' +
      '<div class="sg-note lock"><span class="sg-note-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 11h12v9H6z M9 11V8a3 3 0 0 1 6 0v3"/></svg></span><div><b>차량번호 · 운전원 인적사항</b><br>시스템 입력 없음 → 내부망 별도 송부</div></div>' +
      '</div>';
  }

  // 탭 설명(발표 자료처럼 짧게 — 사용자 결정 2026-10-30). mine = 계정별 할 일(없으면 안 붙임). only = 그 탭이 보이는 계정에서만
  function snowSteps() {
    var rk = roleKey();
    var steps = [
      { center: true, kicker: 'WELCOME', title: '제설 업무 시스템', html:
        '<div class="sg-who-card"><span class="sg-dot"></span><div><small>접속 계정</small><b>' + esc((me() || {}).display_name || '') + '</b><span class="sg-role">' + esc(ROLE[rk]) + '</span></div></div>' +
        '<div class="sg-two"><div class="sg-tile"><i class="cy"></i><b>강설량 측정</b><span>예보 · 신적설 · 관측소 · 관할</span></div><div class="sg-tile"><i class="vi"></i><b>장비 지원</b><span>요청 · 승인 · 배정 · 이동</span></div></div>' },
      { tab: 'forecast', title: '기관별 24시간 예보', desc: '향후 24시간 예상 적설 · 강수 · 최저기온',
        points: ['전국 → 본부 → 지사 → 5km 격자', '격자 선택 → 시간별 추이', '매시 갱신 · 예보 3시간 주기'] },
      { tab: 'snowtable', title: '연도별 신적설', desc: '지사 · 본부별 일 신적설(cm), 시즌 단위',
        points: ['시즌 = 첫눈 ~ 마지막 눈 (11~4월)', '최근 3시즌 조회 · 이전 시즌 엑셀', '매일 새벽 전날 자료 자동 수집'] },
      { tab: 'map', title: '관측소 지도', desc: '지사별 적설관측소 260곳',
        points: ['달력 날짜 선택 → 관측소별 신적설', '관할 고속도로 5km 이내 (최대 8km)'] },
      { tab: 'jurisdiction', title: '기관별 관할 고속도로', desc: '지사별 관할 구간 (IC·JC 단위)',
        points: ['관할 변경 → 관측소 · 신적설 재계산'],
        mine: can('juris.edit') ? '구간 이동 · 신설 기관 · 변경 요청 처리 → [저장]' : can('juris.request') ? '구간 선택 → [구간 변경 요청]' : null },
      { tab: 'sources', title: '데이터 출처', desc: '자료 출처 · 계산 방법 · 보유 시즌',
        points: ['기상청 API허브 · 국가교통정보센터'] },
      { tab: 'grid', only: can('grid.edit'), badge: '관리자', title: '예보 격자 편입', desc: '5km 예보 격자 → 지사 편입',
        points: ['24시간 예보 · 예상 적설의 기준', '저장 즉시 전체 적용'] },
      { target: '#sgHelp', kicker: 'HELP', title: '사용법 다시 보기', desc: '오른쪽 위 [? 사용법]', points: [], last: true }
    ];
    return steps.filter(function (s) { return s.only !== false; });
  }

  function equipSteps() {
    var rk = roleKey(), gwOk = rk === 'admin' || rk === 'gw';
    var steps = [
      { center: true, wide: true, kicker: 'PROCESS', title: '장비 지원 절차', html: processHtml() },
      { tab: 'move', title: '이동 현황', desc: '기관 → 지사 장비 이동, 날짜별',
        points: ['날짜 선택 → 달력 · ‹ › 하루 이동', '지사 카드 시각 = 최초 도착 예상', '강원 신속대응팀 열: 체크박스 표시/숨김'] },
      { tab: 'branch', title: '지사별 요청·편성', desc: '지사 요청 → 재난처 승인(확정)',
        points: ['예보 · 대설특보 자동 표시', '타지사 지원 가능 = 지원 가능 제설차 대수', '확정 줄 잠김 ([취소] 후 수정)'],
        mine: { branch: '요청 대수 · 도착 요청 시각 → [저장]', hq: '본부 내 전 지사 입력 → [저장]', gw: '본부 내 전 지사 입력 → [저장]',
          admin: '기준일자 생성 · 편성 대수 → [확정]' }[rk] },
      { tab: 'fleet', title: '기관별 장비', desc: '지원기관 장비 · 날짜별 경로',
        points: ['지원 여부: 지원 · 미정 · 지원 불가 · 정비중', '지원일 → 지사 · 도착 예상 시각 → [확정]', '차량번호 · 운전원 정보 입력 없음 (내부망)'],
        mine: { equip: '지원 여부 → 배정 지사 → 도착 예상 시각 → [확정]', branch: '타지사 지원 확정 시 장비 등록 · 도착 시각',
          admin: '전 기관 장비 · 경로 수정', gw: '신속대응팀 → 강원본부 지원장비 탭' }[rk] },
      { tab: 'alloc', title: '기관별 배정', desc: '교통처: 기관 → 지사 배정 대수',
        points: ['배정/편성: 초록 일치 · 주황 부족 · 빨강 초과', '배정 후 → 기계화부 장비 지정'],
        mine: { admin: '배정 대수 → [확정]', equip: '우리 기관 배정 확인' }[rk] },
      { tab: 'gwteam', only: gwOk, badge: '강원본부', title: '강원본부 지원장비', desc: '강원 신속대응팀 제설차 4대 (원주 · 홍천 · 대관령 · 강릉)',
        points: ['요청 없이 전국 지사 지원', '요청 · 편성 · 배정 영향 없음 → 이동 현황만 합산', '지원 여부 → 지사 → 도착 시각 → [확정]'],
        mine: rk === 'gw' ? '강원본부 전용 (타 본부 없음)' : null },
      { tab: 'log', only: can('log.view'), badge: '권한', title: '로그 기록', desc: '장비 지원 변경 이력 (최근 300건)',
        points: ['수정 · 삭제 불가', '칸에 마우스 → 당일 수정 기록'] },
      { target: '#sgHelp', kicker: 'HELP', title: '사용법 다시 보기', desc: '오른쪽 위 [? 사용법]', points: [], last: true }
    ];
    return steps.filter(function (s) { return s.only !== false; });
  }

  /* ---------------- 화면 ---------------- */
  function build() {
    var el = doc.createElement('div'); el.id = 'sgRoot'; el.className = 'sg-root';
    el.innerHTML = '<div class="sg-shield"></div><div class="sg-dim"></div><div class="sg-ring" aria-hidden="true"><i></i><i></i><i></i><i></i></div>' +
      '<section class="sg-card" role="dialog" aria-modal="true" aria-labelledby="sgTitle"><span class="sg-arrow" aria-hidden="true"></span><div class="sg-in"></div></section>' +
      '<button type="button" class="sg-stop" id="sgStop"><span aria-hidden="true">✕</span> 설명 그만보기</button>';
    doc.body.appendChild(el);
    el.querySelector('#sgStop').onclick = function () { stop(); };
    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-sg]'); if (!b) return;
      if (b.dataset.sg === 'next') next(); else if (b.dataset.sg === 'prev') go(st.i - 1);
    });
    return el;
  }
  function tabBtn(page, name) { return doc.querySelector(page === 'equip' ? '.eq-btn[data-eqtab="' + name + '"]' : '.tab-btn[data-tab="' + name + '"]'); }
  function visible(el) { return !!(el && !el.hidden && el.offsetParent !== null && el.getClientRects().length); }

  function body(s) {
    if (s.html) return s.html;
    var h = '<p class="sg-desc">' + s.desc + '</p>';
    if (s.points && s.points.length) h += '<ul class="sg-pts">' + s.points.map(function (p) { return '<li>' + p + '</li>'; }).join('') + '</ul>';
    if (s.mine) h += '<div class="sg-mine"><span class="sg-mine-k">내 계정 · ' + esc(ROLE[roleKey()]) + '</span><p>' + esc(s.mine) + '</p></div>';
    return h;
  }

  function render() {
    var s = st.steps[st.i], n = st.steps.length, el = st.el, card = el.querySelector('.sg-card'), ring = el.querySelector('.sg-ring');
    var t = s.tab ? tabBtn(st.page, s.tab) : s.target ? doc.querySelector(s.target) : null;
    if (s.tab && t && visible(t)) t.click();                                         // 그 탭 화면을 뒤에 띄워 둠
    if (t && visible(t) && t.scrollIntoView) { try { t.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {} }
    var tgt = t && visible(t) ? t : null, center = !tgt;
    var ico = s.tab && t ? (t.querySelector('svg') || {}).outerHTML || '' : '';
    var pg = st.page === 'equip' ? '장비 지원' : '강설량 측정';
    el.querySelector('.sg-in').innerHTML =
      '<div class="sg-head"><span class="sg-step"><i></i>' + (s.kicker || 'STEP') + ' · ' + String(st.i + 1).padStart(2, '0') + ' / ' + String(n).padStart(2, '0') + '</span><span class="sg-pg">' + pg + ' 사용법</span></div>' +
      '<div class="sg-title">' + (ico ? '<span class="sg-ico">' + ico + '</span>' : '') + '<h2 id="sgTitle">' + esc(s.title) + '</h2>' + (s.badge ? '<span class="sg-badge">' + esc(s.badge) + '</span>' : '') + '</div>' +
      '<div class="sg-body">' + body(s) + '</div>' +
      '<div class="sg-foot"><div class="sg-prog" aria-hidden="true">' + st.steps.map(function (x, i) { return '<span class="' + (i < st.i ? 'done' : i === st.i ? 'now' : '') + '"></span>'; }).join('') + '</div>' +
      '<div class="sg-btns">' + (st.i > 0 ? '<button type="button" class="sg-prev" data-sg="prev">이전</button>' : '') +
      '<button type="button" class="sg-next" data-sg="next">' + (st.i === n - 1 ? '시작하기' : '다음') + ' <span aria-hidden="true">→</span></button></div></div>';
    card.className = 'sg-card' + (center ? ' center' : '') + (s.wide ? ' wide' : '');
    el.classList.toggle('is-center', center);
    card.classList.remove('anim'); void card.offsetWidth; card.classList.add('anim');
    place(tgt, card, ring);
    var nb = card.querySelector('.sg-next'); if (nb) try { nb.focus({ preventScroll: true }); } catch (e) { nb.focus(); }
    card.querySelector('.sg-body').scrollTop = 0;
  }
  function place(tgt, card, ring) {
    var arrow = card.querySelector('.sg-arrow');
    card.style.left = card.style.top = card.style.bottom = '';
    if (!tgt) { ring.style.opacity = '0'; arrow.style.display = 'none'; return; }
    var r = tgt.getBoundingClientRect(), pad = 5, vw = root.innerWidth, vh = root.innerHeight;
    ring.style.opacity = '1';
    ring.style.left = (r.left - pad) + 'px'; ring.style.top = (r.top - pad) + 'px'; ring.style.width = (r.width + pad * 2) + 'px'; ring.style.height = (r.height + pad * 2) + 'px';
    if (vw <= 640) { arrow.style.display = 'none'; return; }                          // 휴대폰: 아래쪽 카드(CSS)
    var cw = card.offsetWidth, ch = card.offsetHeight, below = r.bottom + 18 + ch <= vh - 8 || r.top < vh / 2;
    var left = Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), vw - cw - 12);
    card.style.left = left + 'px';
    card.style.top = (below ? r.bottom + 18 : Math.max(12, r.top - 18 - ch)) + 'px';
    arrow.style.display = ''; arrow.className = 'sg-arrow ' + (below ? 'up' : 'down');
    arrow.style.left = Math.min(Math.max(18, r.left + r.width / 2 - left), cw - 18) + 'px';
  }

  function go(i) { if (!st) return; st.i = Math.max(0, Math.min(st.steps.length - 1, i)); render(); }
  function next() { if (!st) return; if (st.i >= st.steps.length - 1) stop(); else go(st.i + 1); }
  function stop() {
    if (!st) return;
    var s = st; st = null; markSeen(s.page);
    doc.removeEventListener('keydown', onKey, true); root.removeEventListener('resize', onResize);
    s.el.classList.add('out'); setTimeout(function () { if (s.el.parentNode) s.el.parentNode.removeChild(s.el); }, 220);
    if (s.back && visible(s.back) && !s.back.classList.contains('active')) s.back.click();   // 안내 전에 보던 탭으로
    var h = $('sgHelp'); if (h) try { h.focus({ preventScroll: true }); } catch (e) {}
  }
  function onKey(e) {
    if (!st) return;
    if (e.key === 'Escape') { e.preventDefault(); stop(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(st.i - 1); }
    else if (e.key === 'Tab') {                                                       // 안내 안에서만 돌게
      var f = [].slice.call(st.el.querySelectorAll('button')).filter(visible); if (!f.length) return;
      var a = doc.activeElement, i = f.indexOf(a);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  }
  var rz = 0;
  function onResize() { if (!st) return; cancelAnimationFrame(rz); rz = requestAnimationFrame(function () { if (!st) return; var s = st.steps[st.i];
    var t = s.tab ? tabBtn(st.page, s.tab) : s.target ? doc.querySelector(s.target) : null; place(t && visible(t) ? t : null, st.el.querySelector('.sg-card'), st.el.querySelector('.sg-ring')); }); }

  function start(page) {
    if (!me() || !doc.body.classList.contains('authed')) return;
    if (st) stop();
    page = page || curPage();
    var back = doc.querySelector(page === 'equip' ? '.eq-btn.active' : '.tab-btn.active');
    st = { page: page, steps: page === 'equip' ? equipSteps() : snowSteps(), i: 0, el: build(), back: back };
    doc.addEventListener('keydown', onKey, true); root.addEventListener('resize', onResize);
    render();
  }
  // 저절로 열기: 그 페이지를 이 브라우저·아이디로 처음 볼 때 한 번
  function auto(page) {
    if (!AUTO || st || waiting[page] || seen(page) || !me()) return;
    waiting[page] = true;
    initP.then(function () { setTimeout(function () { waiting[page] = false; if (!st && !seen(page) && curPage() === page) start(page); }, page === 'equip' ? 1200 : 700); });
  }
  function init() {
    if (inited || !me()) return; inited = true;
    var box = $('ssUser'), host = box && box.parentNode;
    if (host && !$('sgHelp')) {
      var b = doc.createElement('button'); b.type = 'button'; b.id = 'sgHelp'; b.className = 'sg-help'; b.title = '이 페이지 사용법 다시 보기';
      b.innerHTML = '<span class="sg-help-q" aria-hidden="true">?</span>사용법';
      b.onclick = function () { start(curPage()); };
      host.insertBefore(b, box);
    }
    var m = me();
    if (m.role === 'hq' && m.hq_id && root.SSAuth && root.SSAuth.rest) {           // 강원본부인지(본부 이름) — 안내 내용만 달라짐
      initP = root.SSAuth.rest('hqs?select=id,name&id=eq.' + encodeURIComponent(m.hq_id)).then(function (r) {
        var h = r && r.ok && Array.isArray(r.json) ? r.json.filter(function (x) { return x.id === m.hq_id; })[0] : null; hqName = h ? h.name : null;
      }).catch(function () {});
    }
    return initP;
  }
  root.SSGuide = { init: init, auto: auto, start: start, stop: stop, active: function () { return st ? { page: st.page, i: st.i, n: st.steps.length, title: st.steps[st.i].title } : null; } };
})(window);
