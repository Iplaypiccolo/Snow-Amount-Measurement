/* ============================================================
   auth/events.js — 관할 변경·격자 편입 "변경 이력"을 서버(Supabase)에서 읽고 저장하는 부품
   - 읽기: 로그인한 모든 사용자가 읽습니다(화면이 계산에 씀). 서버에 연결할 수 없으면 예전 파일(data/*_changes.json)로 대신 보고 source:'file' 로 알려 줍니다.
   - 저장: 관리자만 할 수 있습니다(서버가 검사). 여러 줄은 한 번에, 하나라도 잘못되면 전부 취소됩니다. 저장하면 모든 사용자에게 바로 적용됩니다.
   - 화면의 변경 이벤트(t: 'move' / 'add' …)와 DB 행(kind, payload, note)을 서로 바꿔 줍니다.
   ============================================================ */
(function (root) {
  'use strict';
  var DOM = {
    jurisdiction: { table: 'jurisdiction_events', file: 'data/jurisdiction_changes.json', toKind: function (t) { return t; }, fromKind: function (k) { return k; } },
    grid: { table: 'grid_events', file: 'data/grid_changes.json',
      toKind: function (t) { return t === 'add' ? 'cellAdd' : t === 'remove' ? 'cellRemove' : t; },
      fromKind: function (k) { return k === 'cellAdd' ? 'add' : k === 'cellRemove' ? 'remove' : k; } }
  };
  var PAGE = 1000;          // 서버가 한 번에 돌려주는 최대 줄 수(그 이상은 나눠서 읽음)

  function toRow(domain, ev, defaultNote) {
    var payload = {}; Object.keys(ev).forEach(function (k) { if (k !== 't' && k !== 'at' && k !== 'note' && k !== 'id') payload[k] = ev[k]; });
    return { kind: DOM[domain].toKind(ev.t), payload: payload, note: ev.note || defaultNote || null };     // 저장 시각·작성자는 서버가 정함
  }
  function fromRow(domain, row) {
    var ev = {}; var p = row.payload || {}; Object.keys(p).forEach(function (k) { ev[k] = p[k]; });
    ev.t = DOM[domain].fromKind(row.kind); ev.at = row.at; ev.id = row.id; if (row.note) ev.note = row.note; return ev;
  }
  function fromFile(domain) {
    return fetch(DOM[domain].file, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      .then(function (j) { return { events: (j && Array.isArray(j.events)) ? j.events : [], source: 'file' }; });
  }
  // 반환: { events, source: 'server' | 'file', error?: true }   (file 이면 서버에서 못 읽어서 예전 파일로 대신한 것)
  function load(domain) {
    var A = root.SSAuth; if (!A || !A.hasSession()) return fromFile(domain);
    var all = [];
    function page(offset) {
      return A.rest(DOM[domain].table + '?select=id,at,kind,payload,note&order=id.asc&limit=' + PAGE + '&offset=' + offset).then(function (r) {
        if (!r.ok || !Array.isArray(r.json)) throw new Error('load');
        all = all.concat(r.json); return r.json.length === PAGE ? page(offset + PAGE) : null;
      });
    }
    return page(0).then(function () { return { events: all.map(function (row) { return fromRow(domain, row); }), source: 'server' }; })
      .catch(function () { return fromFile(domain).then(function (x) { x.error = true; return x; }); });
  }
  function friendly(r) {
    var code = r && r.json && r.json.code;
    if (code === '42501' || (r && (r.status === 401 || r.status === 403))) return '저장할 권한이 없습니다. 관리자 아이디로 로그인했는지 확인하세요.';
    if (code === '23514') return '변경 내용이 서버 규칙에 맞지 않습니다.';
    return '서버에 저장하지 못했습니다. 잠시 뒤에 다시 시도하세요.';
  }
  // events: 화면의 변경 이벤트 목록, note: 변경 사유(이벤트에 따로 없을 때 쓰는 기본값)
  function append(domain, events, note) {
    if (!events || !events.length) return Promise.resolve({ ok: true });
    var A = root.SSAuth; if (!A) return Promise.resolve({ ok: false, message: '로그인 부품을 불러오지 못했습니다.' });
    var rows = events.map(function (ev) { return toRow(domain, ev, note); });
    return A.authed('/rest/v1/' + DOM[domain].table, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: rows })
      .then(function (r) { return r.ok ? { ok: true } : { ok: false, message: friendly(r) }; })
      .catch(function () { return { ok: false, message: A.NET_MSG }; });
  }
  // 백업·비상용 파일 내용 (예전 파일 형식과 같음)
  function exportJson(events) { return JSON.stringify({ version: 1, events: events.map(function (e) { var c = JSON.parse(JSON.stringify(e)); delete c.id; return c; }) }, null, 1); }
  function download(name, text) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  root.SSEvents = { load: load, append: append, toRow: toRow, fromRow: fromRow, exportJson: exportJson, download: download, PAGE: PAGE };
})(window);
