/* ============================================================
   auth/snow.js — 일 신적설을 서버(Supabase)의 요약본(snapshots 'snow') 한 줄에서 읽는 부품
   - 요약본 모양: { version, seasons: { "2025-11-15~2026-03-15": { dates:[YYYYMMDD…], st:{ 관측소번호:[값|null…] } } } }
   - 화면이 예전부터 쓰던 모양(SNOW_DATA)으로 바꿔 줍니다: { seasons:{ 시즌:{ dates, branches:{} } }, stationData:{ 관측소:{ 날짜:값 } } }
     지사별 값(branches)은 비워 두고, 화면이 관할에 맞춰 계산합니다(JurisCore.rebuildAllSeries / reapply).
   - 로그인한 사람만 읽을 수 있습니다(서버가 검사). 예전처럼 공개 파일(data/snow_data.json)을 읽지 않습니다.
   - 요약본은 약 1.5MB(압축해 보내도 수백 KB)라 매번 받으면 무료 한도(내려받기 월 5GB)를 넘을 수 있습니다.
     → 먼저 만든 시각(built_at)만 묻고, 이 브라우저(IndexedDB)에 같은 시각의 요약본이 있으면 그것을 씀. 새로 만들어졌을 때만 다시 받음.
   ============================================================ */
(function (root) {
  'use strict';
  function fromSnapshot(body) {
    var out = { seasons: {}, stationData: {} };
    var ss = (body && body.seasons) || {};
    Object.keys(ss).forEach(function (label) {
      var s = ss[label], dates = s.dates || [], st = s.st || {};
      out.seasons[label] = { dates: dates.slice(), branches: {} };
      Object.keys(st).forEach(function (stn) {
        var arr = st[stn], rec = out.stationData[stn] || (out.stationData[stn] = {});
        for (var i = 0; i < dates.length; i++) if (arr[i] != null) rec[dates[i]] = arr[i];
      });
    });
    return out;
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

  function done(body, builtAt) { var data = fromSnapshot(body); data.builtAt = builtAt || null; return data; }
  // 반환: Promise<SNOW_DATA>. 못 읽으면 오류(화면이 안내)
  function load() {
    var A = root.SSAuth; if (!A) return Promise.reject(new Error('no_auth'));
    return A.rest('snapshots?key=eq.snow&select=built_at').then(function (r) {         // 만든 시각만(수십 바이트)
      if (!r.ok || !Array.isArray(r.json)) throw new Error('snow_load_failed');
      var built = r.json[0] ? r.json[0].built_at : null;
      if (!built) return done(null, null);
      return cacheGet('snow').then(function (c) {
        if (c && c.built_at === built && c.body) return done(c.body, built);          // 보관한 것과 같으면 다시 받지 않음
        return A.rest('snapshots?key=eq.snow&select=body,built_at').then(function (r2) {
          if (!r2.ok || !Array.isArray(r2.json)) throw new Error('snow_load_failed');
          var row = r2.json[0];
          if (row && row.body) cachePut('snow', { built_at: row.built_at, body: row.body });
          return done(row ? row.body : null, row ? row.built_at : null);
        });
      });
    });
  }
  var api = { load: load, fromSnapshot: fromSnapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SSSnow = api;
})(typeof window !== 'undefined' ? window : this);
