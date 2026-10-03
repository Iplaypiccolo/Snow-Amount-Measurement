/* ============================================================
   auth/snow.js — 일 신적설을 서버(Supabase)의 요약본(snapshots 'snow') 한 줄에서 읽는 부품
   - 요약본 모양: { version, seasons: { "2025-11-15~2026-03-15": { dates:[YYYYMMDD…], st:{ 관측소번호:[값|null…] } } } }
   - 화면이 예전부터 쓰던 모양(SNOW_DATA)으로 바꿔 줍니다: { seasons:{ 시즌:{ dates, branches:{} } }, stationData:{ 관측소:{ 날짜:값 } } }
     지사별 값(branches)은 비워 두고, 화면이 관할에 맞춰 계산합니다(JurisCore.rebuildAllSeries / reapply).
   - 로그인한 사람만 읽을 수 있습니다(서버가 검사). 예전처럼 공개 파일(data/snow_data.json)을 읽지 않습니다.
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
  // 반환: Promise<SNOW_DATA>. 못 읽으면 오류(화면이 안내)
  function load() {
    var A = root.SSAuth; if (!A) return Promise.reject(new Error('no_auth'));
    return A.rest('snapshots?key=eq.snow&select=body,built_at').then(function (r) {
      if (!r.ok || !Array.isArray(r.json)) throw new Error('snow_load_failed');
      var row = r.json[0];
      var data = fromSnapshot(row ? row.body : null);
      data.builtAt = row ? row.built_at : null;
      return data;
    });
  }
  var api = { load: load, fromSnapshot: fromSnapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SSSnow = api;
})(typeof window !== 'undefined' ? window : this);
