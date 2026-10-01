/* ============================================================
   jurisdiction/core.js — 관할 변경 계산 (화면 없이 계산만 하는 부분)
   - 구간(sections)의 소속을 바꾸고, 지사를 새로 만들고, 지사의 본부를 바꾸는 "변경 이벤트"를 적용합니다.
   - 바뀐 지사만 관측소 배정(반경 5km, 5대 이하면 6→7→8km)과 일별 신적설을 다시 계산합니다.
   - 브라우저에서는 window.JurisCore, Node(테스트)에서는 require() 로 쓸 수 있습니다.

   변경 이벤트 3종 (data/jurisdiction_changes.json 의 events 배열에 순서대로 쌓임)
     { t:'move',     sections:['S0001',...], to:'B012' }         구간들을 다른 지사로 이동
     { t:'addBranch', id:'B060', hq:'강원', name:'신설지사' }    신설 기관 추가
     { t:'moveHq',   branch:'B012', hq:'충북' }                  지사를 다른 본부로 이동
   ============================================================ */
(function (root) {
  'use strict';

  var RADIUS_STEPS = [5, 6, 7, 8];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function nameTaken(branches, name) {
    var n = String(name).trim();
    return Object.keys(branches).some(function (id) { return branches[id].name === n; });
  }

  /* ---------- 1) 이벤트를 적용한 "소속 상태" 계산 ---------- */
  function resolve(doc, events) {
    var branches = {}, order = [], owner = {};
    doc.branches.forEach(function (b) { branches[b.id] = { id: b.id, hq: b.hq, name: b.name, added: false }; order.push(b.id); });
    doc.sections.forEach(function (s) { owner[s.id] = s.owner; });
    var applied = [], skipped = [];
    (events || []).forEach(function (ev) {
      var ok = false;
      if (ev.t === 'addBranch') {
        var nm = String(ev.name || '').trim();
        if (ev.id && nm && doc.hqs.indexOf(ev.hq) >= 0 && !branches[ev.id] && !nameTaken(branches, nm)) {
          branches[ev.id] = { id: ev.id, hq: ev.hq, name: nm, added: true };
          order.push(ev.id);
          ok = true;
        }
      } else if (ev.t === 'moveHq') {
        var b = branches[ev.branch];
        if (b && doc.hqs.indexOf(ev.hq) >= 0 && b.hq !== ev.hq) { b.hq = ev.hq; ok = true; }
      } else if (ev.t === 'move') {
        if (branches[ev.to]) {
          (ev.sections || []).forEach(function (sid) {
            if (sid in owner && owner[sid] !== ev.to) { owner[sid] = ev.to; ok = true; }
          });
        }
      }
      (ok ? applied : skipped).push(ev);
    });
    return { hqs: doc.hqs.slice(), branches: branches, order: order, owner: owner, applied: applied, skipped: skipped };
  }

  /* ---------- 2) 구간 → 지사의 선(routeSegments) ---------- */
  function buildSegments(secs) {
    var sorted = secs.slice().sort(function (a, b) {
      return a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : a.order - b.order;
    });
    var segs = [], cur = null, prev = null;
    sorted.forEach(function (s) {
      if (cur && prev && prev.chain === s.chain && s.order === prev.order + 1) {
        Array.prototype.push.apply(cur.coords, s.coords.slice(1));
      } else {
        cur = { route: s.route, coords: s.coords.slice() };
        segs.push(cur);
      }
      prev = s;
    });
    return segs;
  }

  /* ---------- 3) 관측소 배정 규칙 (지금 사이트의 규칙 그대로) ---------- */
  function distToSegments(lat, lon, segs) {
    var kx = 111.320 * Math.cos(lat * Math.PI / 180), ky = 110.574, best = 1e9, road = null;
    for (var s = 0; s < segs.length; s++) {
      var c = segs[s].coords;
      for (var k = 0; k < c.length - 1; k++) {
        var ax = (c[k][0] - lon) * kx, ay = (c[k][1] - lat) * ky;
        var bx = (c[k + 1][0] - lon) * kx, by = (c[k + 1][1] - lat) * ky;
        var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        var t = L2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
        var d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < best) { best = d; road = segs[s].route; }
      }
    }
    return { d: best, road: road };
  }

  // 관할 선에서 5km 이내 관측소가 5대 초과면 확정, 5대 이하면 6→7→8km 로 넓힘 (8km 에서 멈춤)
  function pickStations(segs, stationList) {
    var ds = stationList.map(function (st) { var r = distToSegments(st.lat, st.lon, segs); return { st: st, d: r.d, road: r.road }; });
    var radius = 5, sel = [];
    for (var i = 0; i < RADIUS_STEPS.length; i++) {
      radius = RADIUS_STEPS[i];
      sel = ds.filter(function (x) { return x.d <= radius; });
      if (sel.length > 5 || radius === 8) break;
    }
    sel.sort(function (a, b) { return a.d - b.d; });
    return {
      radiusKm: radius,
      stations: sel.map(function (x) {
        return { id: x.st.id, name: x.st.name, addr: x.st.addr == null ? null : x.st.addr, lat: x.st.lat, lon: x.st.lon,
                 dist_km: Math.round(x.d * 1000) / 1000, road: x.road };
      })
    };
  }

  /* ---------- 4) 일별 신적설: 지사 하루 값 = 배정 관측소들의 그날 최댓값 ---------- */
  function seasonSeries(season, stationData, stations) {
    return season.dates.map(function (date) {
      var max = null;
      stations.forEach(function (s) {
        var rec = stationData[String(s.id)];
        var v = rec ? rec[date] : null;
        if (v != null && (max === null || v > max)) max = v;
      });
      return max;
    });
  }
  function setBranchSeries(S, key, stations) {
    Object.keys(S.seasons).forEach(function (k) { S.seasons[k].branches[key] = seasonSeries(S.seasons[k], S.stationData, stations); });
  }

  function findBranch(H, hqName, name) {
    var hq = H.hq.filter(function (h) { return h.name === hqName; })[0];
    if (!hq) return null;
    var b = hq.branches.filter(function (x) { return x.name === name; })[0];
    return b ? { hq: hq, branch: b } : null;
  }

  function centerOf(segs) {
    var pts = [];
    segs.forEach(function (s) { s.coords.forEach(function (c) { pts.push(c); }); });
    if (!pts.length) return null;
    var m = pts[Math.floor(pts.length / 2)];
    return [Math.round(m[1] * 10000) / 10000, Math.round(m[0] * 10000) / 10000];
  }

  /* ---------- 5) 실제 데이터(HIERARCHY, SNOW_DATA)에 이벤트 반영 ---------- */
  function applyToData(H, S, doc, stationsDoc, events) {
    var st = resolve(doc, events);
    var baseOwner = {}, baseHq = {};
    doc.sections.forEach(function (s) { baseOwner[s.id] = s.owner; });
    doc.branches.forEach(function (b) { baseHq[b.id] = b.hq; });
    var geomDirty = {}, hqMoved = {};
    doc.sections.forEach(function (s) {
      var now = st.owner[s.id];
      if (now !== baseOwner[s.id]) { geomDirty[now] = true; geomDirty[baseOwner[s.id]] = true; }
    });
    st.order.forEach(function (id) {
      var b = st.branches[id];
      if (b.added) geomDirty[id] = true;
      else if (b.hq !== baseHq[id]) hqMoved[id] = true;
    });
    var hqByName = {};
    H.hq.forEach(function (h) { hqByName[h.name] = h; });
    var canRecompute = !!(stationsDoc && stationsDoc.stations && stationsDoc.stations.length);
    var changed = [];

    st.order.forEach(function (id) {
      var b = st.branches[id];
      if (!geomDirty[id] && !hqMoved[id]) return;
      var oldHqName = b.added ? null : baseHq[id];
      var oldKey = b.added ? null : oldHqName + '|||' + b.name;
      var found = b.added ? null : findBranch(H, oldHqName, b.name);
      var obj = found ? found.branch : { name: b.name, count: 0, anchor: null, radiusKm: 5, stations: [], routeSegments: [] };
      var oldCount = found ? obj.count : 0;
      var recomputed = false;

      if (geomDirty[id]) {
        var secs = doc.sections.filter(function (s) { return st.owner[s.id] === id; });
        obj.routeSegments = buildSegments(secs);
        if (canRecompute) {
          var pick = pickStations(obj.routeSegments, stationsDoc.stations);
          obj.stations = pick.stations; obj.radiusKm = pick.radiusKm; obj.count = pick.stations.length;
          recomputed = true;
        }
        if (!obj.anchor) obj.anchor = centerOf(obj.routeSegments);
      }

      var newHq = hqByName[b.hq];
      if (found && found.hq !== newHq) {                 // 본부 이동: 원래 본부에서 빼고 새 본부에 넣음
        found.hq.branches = found.hq.branches.filter(function (x) { return x !== obj; });
        found.hq.count -= oldCount;
        newHq.branches.push(obj);
        newHq.count += obj.count;
      } else if (!found) {                               // 신설 기관
        newHq.branches.push(obj);
        newHq.count += obj.count;
      } else {                                           // 같은 본부 안에서 관측소 수만 바뀜
        newHq.count += obj.count - oldCount;
      }

      var newKey = b.hq + '|||' + b.name;
      if (recomputed || !found) {
        setBranchSeries(S, newKey, obj.stations);
      } else if (oldKey !== newKey) {                    // 관측소는 그대로, 키만 바뀜 → 시리즈 복사
        Object.keys(S.seasons).forEach(function (k) {
          var br = S.seasons[k].branches;
          if (br[oldKey]) br[newKey] = br[oldKey];
        });
      }
      if (oldKey && oldKey !== newKey) {
        Object.keys(S.seasons).forEach(function (k) { delete S.seasons[k].branches[oldKey]; });
      }
      changed.push({ id: id, key: newKey, oldKey: oldKey, added: b.added });
    });
    return { state: st, changed: changed, recomputed: canRecompute };
  }

  /* ---------- 6) 저장 전 미리보기: 두 상태(이벤트 목록 A, B)를 비교 ---------- */
  function latestSeasonKey(S) { return Object.keys(S.seasons).sort().slice(-1)[0]; }
  function maxOf(arr) { var m = null; arr.forEach(function (v) { if (v != null && (m === null || v > m)) m = v; }); return m; }

  function evaluate(doc, stationsDoc, S, events, ids) {
    var st = resolve(doc, events), out = {};
    var latest = latestSeasonKey(S);
    ids.forEach(function (id) {
      var b = st.branches[id];
      if (!b) { out[id] = null; return; }
      var secs = doc.sections.filter(function (s) { return st.owner[s.id] === id; });
      var segs = buildSegments(secs);
      var pick = stationsDoc && stationsDoc.stations ? pickStations(segs, stationsDoc.stations) : { radiusKm: null, stations: [] };
      var all = Object.keys(S.seasons).map(function (k) { return maxOf(seasonSeries(S.seasons[k], S.stationData, pick.stations)); });
      out[id] = {
        id: id, name: b.name, hq: b.hq, sections: secs.length,
        km: Math.round(secs.reduce(function (a, s) { return a + s.km; }, 0) * 10) / 10,
        radiusKm: pick.radiusKm, stations: pick.stations.map(function (x) { return x.name; }),
        latestMax: maxOf([maxOf(seasonSeries(S.seasons[latest], S.stationData, pick.stations))]), allMax: maxOf(all)
      };
    });
    return out;
  }

  function impact(doc, stationsDoc, S, eventsBefore, eventsAfter) {
    var A = resolve(doc, eventsBefore), B = resolve(doc, eventsAfter);
    var ids = {};
    Object.keys(B.branches).forEach(function (id) {
      var a = A.branches[id], b = B.branches[id];
      if (!a || a.hq !== b.hq) ids[id] = true;
    });
    doc.sections.forEach(function (s) {
      if (A.owner[s.id] !== B.owner[s.id]) { ids[A.owner[s.id]] = true; ids[B.owner[s.id]] = true; }
    });
    var list = Object.keys(ids);
    var before = evaluate(doc, stationsDoc, S, eventsBefore, list), after = evaluate(doc, stationsDoc, S, eventsAfter, list);
    return list.map(function (id) {
      var a = before[id], b = after[id];
      var bs = a ? a.stations : [], as = b ? b.stations : [];
      return {
        id: id, before: a, after: b,
        added: as.filter(function (n) { return bs.indexOf(n) < 0; }),
        removed: bs.filter(function (n) { return as.indexOf(n) < 0; })
      };
    }).sort(function (x, y) { return (x.after ? x.after.name : '').localeCompare(y.after ? y.after.name : ''); });
  }

  /* ---------- 7) 소속 요약 (화면 목록용) ---------- */
  function summarize(doc, events) {
    var st = resolve(doc, events), km = {}, cnt = {};
    doc.sections.forEach(function (s) {
      var o = st.owner[s.id];
      km[o] = (km[o] || 0) + s.km; cnt[o] = (cnt[o] || 0) + 1;
    });
    return { state: st, km: km, count: cnt };
  }

  var api = {
    resolve: resolve, buildSegments: buildSegments, pickStations: pickStations, distToSegments: distToSegments,
    applyToData: applyToData, impact: impact, evaluate: evaluate, summarize: summarize,
    seasonSeries: seasonSeries, clone: clone, latestSeasonKey: latestSeasonKey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JurisCore = api;
})(typeof window !== 'undefined' ? window : this);
