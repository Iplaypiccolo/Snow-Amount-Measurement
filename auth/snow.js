/* ============================================================
   auth/snow.js — 일 신적설을 서버(Supabase)의 요약본(snapshots)에서 읽는 부품
   - 요약본은 시즌별로 나뉘어 있습니다(2026-10-05, 내려받는 양 줄이기):
       'snow'          = 목록 { version:2, seasons:[{ label, days, data_days, stations }] }
       'snow:<시즌>'   = { dates:[YYYYMMDD…], st:{ 관측소번호:[값|null…] } } — 화면이 쓰는 관측소(좌표 있는 곳)만
     처음에는 가장 최근 시즌 하나만 받고, 다른 시즌은 고를 때(loadSeason) 받습니다.
     예전 모양(version 1: 'snow' 한 줄에 모든 시즌)도 그대로 읽습니다.
   - 화면이 예전부터 쓰던 모양(SNOW_DATA)으로 바꿔 줍니다: { seasons:{ 시즌:{ dates, branches:{} } }, stationData:{ 관측소:{ 날짜:값 } } }
     지사별 값(branches)은 비워 두고, 화면이 관할에 맞춰 계산합니다(JurisCore.rebuildAllSeries / reapply).
     덧붙임: index(서버에 있는 시즌 목록), recent(드롭다운에 보일 최근 3시즌), older(그 이전 시즌 — 엑셀로만 받음)
   - 로그인한 사람만 읽을 수 있습니다(서버가 검사).
   - 만든 시각(built_at)만 먼저 묻고, 이 브라우저(IndexedDB)에 같은 시각의 것이 있으면 다시 받지 않습니다.
   ============================================================ */
(function (root) {
  'use strict';
  var RECENT = 3;

  // 시즌 하나({dates, st})를 SNOW_DATA 에 더함
  function addSeason(out, label, s) {
    var dates = (s && s.dates) || [], st = (s && s.st) || {};
    out.seasons[label] = { dates: dates.slice(), branches: {} };
    Object.keys(st).forEach(function (stn) {
      var arr = st[stn], rec = out.stationData[stn] || (out.stationData[stn] = {});
      for (var i = 0; i < dates.length; i++) if (arr[i] != null) rec[dates[i]] = arr[i];
    });
    return out;
  }
  // 예전 모양(version 1) 한 덩어리 → SNOW_DATA
  function fromSnapshot(body) {
    var out = { seasons: {}, stationData: {} };
    var ss = (body && body.seasons) || {};
    if (Array.isArray(ss)) return out;
    Object.keys(ss).forEach(function (label) { addSeason(out, label, ss[label]); });
    return out;
  }
  function withIndex(data, index) {
    data.index = index;
    var labels = index.map(function (x) { return x.label; }).sort();
    data.recent = labels.slice(-RECENT);
    data.older = labels.slice(0, Math.max(0, labels.length - RECENT));
    return data;
  }

  /* ---------- 이 브라우저 보관함(IndexedDB). 못 쓰는 환경이면 그냥 매번 받음 ---------- */
  var DBN = 'ss-cache', ST = 'kv';
  function idb() {
    return new Promise(function (res) {
      try { var q = root.indexedDB.open(DBN, 1); q.onupgradeneeded = function () { q.result.createObjectStore(ST); }; q.onsuccess = function () { res(q.result); }; q.onerror = function () { res(null); }; }
      catch (e) { res(null); }
    });
  }
  function cacheGet(k) {
    return idb().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) { try { var q = db.transaction(ST).objectStore(ST).get(k); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; } catch (e) { res(null); } });
    });
  }
  function cachePut(k, v) { idb().then(function (db) { if (!db) return; try { db.transaction(ST, 'readwrite').objectStore(ST).put(v, k); } catch (e) {} }); }

  // 요약본 몇 줄을 받음: built = { key: built_at }. 보관한 것과 같으면 보관한 것, 아니면 서버에서(한 번에)
  function fetchBodies(keys, built) {
    var A = root.SSAuth, got = {};
    return Promise.all(keys.map(function (k) {
      return cacheGet(k).then(function (c) { if (c && c.built_at === built[k] && c.body) got[k] = c.body; });
    })).then(function () {
      var need = keys.filter(function (k) { return !got[k]; });
      if (!need.length) return got;
      var list = need.map(function (k) { return '"' + k + '"'; }).join(',');
      return A.rest('snapshots?key=in.(' + encodeURIComponent(list) + ')&select=key,body,built_at').then(function (r) {
        if (!r.ok || !Array.isArray(r.json)) throw new Error('snow_load_failed');
        r.json.forEach(function (row) {
          if (!row || !row.body) return;
          got[row.key] = row.body; built[row.key] = row.built_at;
          cachePut(row.key, { built_at: row.built_at, body: row.body });
        });
        return got;
      });
    });
  }

  // 반환: Promise<SNOW_DATA>(가장 최근 시즌만 들어 있음). 못 읽으면 오류(화면이 안내)
  function load() {
    var A = root.SSAuth; if (!A) return Promise.reject(new Error('no_auth'));
    return A.rest('snapshots?key=like.snow*&select=key,built_at').then(function (r) {      // 만든 시각만(수백 바이트)
      if (!r.ok || !Array.isArray(r.json)) throw new Error('snow_load_failed');
      var built = {};
      r.json.forEach(function (row) { built[row.key] = row.built_at; });
      if (!built.snow) return withIndex({ seasons: {}, stationData: {}, builtAt: null, _built: built }, []);
      return fetchBodies(['snow'], built).then(function (got) {
        var idx = got.snow || {};
        if (!Array.isArray(idx.seasons)) {                                                  // 예전 모양: 모든 시즌이 한 덩어리
          var all = fromSnapshot(idx); all.builtAt = built.snow; all._built = built;
          return withIndex(all, Object.keys(all.seasons).map(function (l) { return { label: l, days: all.seasons[l].dates.length }; }));
        }
        var data = withIndex({ seasons: {}, stationData: {}, builtAt: built.snow, _built: built }, idx.seasons);
        var last = data.recent[data.recent.length - 1];
        return last ? loadSeason(data, last) : data;
      });
    });
  }
  // 시즌 하나를 더 받아 data 에 넣음(이미 있으면 그대로). 반환: Promise<data>
  function loadSeason(data, label) {
    if (data.seasons[label]) return Promise.resolve(data);
    var k = 'snow:' + label;
    if (!data._built || !data._built[k]) return Promise.reject(new Error('no_season'));
    return fetchBodies([k], data._built).then(function (got) {
      if (!got[k]) throw new Error('snow_load_failed');
      addSeason(data, label, got[k]);
      return data;
    });
  }
  // 아직 안 받은 시즌을 모두 한 번에(관할 미리보기의 '전체 시즌 최대' 계산용)
  function loadAll(data) {
    var labels = (data.index || []).map(function (x) { return x.label; }).filter(function (l) { return !data.seasons[l]; });
    if (!labels.length) return Promise.resolve(data);
    var keys = labels.map(function (l) { return 'snow:' + l; });
    return fetchBodies(keys, data._built).then(function (got) {
      labels.forEach(function (l) { if (got['snow:' + l]) addSeason(data, l, got['snow:' + l]); });
      return data;
    });
  }
  var api = { load: load, loadSeason: loadSeason, loadAll: loadAll, fromSnapshot: fromSnapshot, addSeason: addSeason, RECENT: RECENT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SSSnow = api;
})(typeof window !== 'undefined' ? window : this);
