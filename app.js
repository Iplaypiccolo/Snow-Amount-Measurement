function initApp(){
  // 안전장치: href="#" 형태의 빈 링크가 클릭될 때 상위 프레임으로 이동하는 것을 전역적으로 방지
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a');
    if(a && (a.getAttribute('href') === '#' || a.getAttribute('href') === '')){
      e.preventDefault();
    }
  }, true);

  // ---------- 탭 전환 ----------
  var rowRegistry = {};      // brKey -> {hqRow, brRow}
  var snowBadgeRegistry = {}; // brKey -> DOM element
  var stationRowRegistry = {}; // stationId -> DOM element (.st-snow span)

  function switchTab(name){
    document.querySelectorAll('.tab-btn').forEach(function(b){
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.getElementById('view-map').style.display = (name==='map') ? 'flex' : 'none';
    document.getElementById('view-snowtable').style.display = (name==='snowtable') ? 'flex' : 'none';
    document.getElementById('view-sources').style.display = (name==='sources') ? 'block' : 'none';
    if(name === 'map'){ setTimeout(function(){ map.invalidateSize(); }, 50); }
    if(name === 'snowtable'){ buildSnowTable(); }
  }
  document.querySelectorAll('.tab-btn').forEach(function(btn){
    btn.addEventListener('click', function(){ switchTab(btn.dataset.tab); });
  });

  // ---------- 통계 ----------
  var branchCount = HIERARCHY.hq.reduce(function(sum,h){return sum + h.branches.length;}, 0);
  var withinCount = HIERARCHY.hq.reduce(function(sum,h){return sum + h.count;}, 0);
  document.getElementById('statRoads').textContent = (new Set(ROADS_DATA.map(function(r){return r.name;}))).size;
  document.getElementById('statHQ').textContent = HIERARCHY.hq.length;
  document.getElementById('statBranch').textContent = branchCount;
  document.getElementById('statWithin').textContent = withinCount;
  document.getElementById('statUnclass').textContent = HIERARCHY.unclassified.length;
  document.getElementById('genMeta').textContent =
    '고속도로 중심선 반경 5km 이내 공식 적설관측지점 · 본부/지사 관할 구간 기준 배정 (' + META_DATE + ' 자료 기준)';

  // ---------- 지도 ----------
  var map = L.map('map', {zoomControl:true}).setView([36.4, 127.9], 7);
  map.createPane('stationsPane');
  map.getPane('stationsPane').style.zIndex = 450; // 기본 overlayPane(400)보다 위 = 노선 위에 관측소 표시
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  var legend = L.control({position:'bottomleft'});
  legend.onAdd = function(){
    var div = L.DomUtil.create('div','legend');
    div.innerHTML =
      '<div class="row"><span class="line"></span> 고속도로 중심선</div>'+
      '<div class="row"><span class="dot" style="background:#0b5d38"></span> 0 ~ 3km</div>'+
      '<div class="row"><span class="dot" style="background:#c97a2b"></span> 3 ~ 6km</div>'+
      '<div class="row"><span class="dot" style="background:#b5432f"></span> 6 ~ 8km</div>';
    return div;
  };
  legend.addTo(map);

  // 팝업 닫기(X) 버튼이 href="#" 링크라서 상위 프레임으로 잘못 이동하는 문제 방지
  map.on('popupopen', function(e){
    var btn = e.popup && e.popup._closeButton;
    if(btn){
      btn.removeAttribute('href');
      btn.style.cursor = 'pointer';
      L.DomEvent.off(btn, 'click');
      L.DomEvent.on(btn, 'click', function(ev){
        L.DomEvent.preventDefault(ev);
        L.DomEvent.stopPropagation(ev);
        map.closePopup(e.popup);
      });
    }
  });

  ROADS_DATA.forEach(function(r){
    var latlngs = r.coords.map(function(c){return [c[1], c[0]];});
    L.polyline(latlngs, {color:'#0b5d38', weight:2, opacity:0.75}).addTo(map)
      .bindTooltip(r.name, {sticky:true, direction:'top'});
  });

  function bandColor(distKm){
    if(distKm <= 3) return '#0b5d38';
    if(distKm <= 6) return '#c97a2b';
    return '#b5432f';
  }

  var markerById = {};
  var allStationsFlat = [];
  var seenStationIds = {};
  HIERARCHY.hq.forEach(function(hq){
    hq.branches.forEach(function(br){
      br.stations.forEach(function(s){
        if(!seenStationIds[s.id]){ seenStationIds[s.id] = true; allStationsFlat.push(s); }
      });
    });
  });
  HIERARCHY.unclassified.forEach(function(s){
    if(!seenStationIds[s.id]){ seenStationIds[s.id] = true; allStationsFlat.push(s); }
  });

  allStationsFlat.forEach(function(s){
    var baseColor = bandColor(s.dist_km);
    var marker = L.circleMarker([s.lat, s.lon], {
      pane: 'stationsPane',
      radius:5, color:'#fff', weight:1,
      fillColor: baseColor, fillOpacity:0.9
    }).addTo(map);
    marker._baseColor = baseColor;
    var addrLine = s.addr ? ('<div>'+s.addr+'</div>') : '';
    var basePopup =
      '<b>'+s.name+'</b> <span style="color:#6b6455">(지점 '+s.id+')</span>'+addrLine+
      '<div>최근접 노선: '+s.road+'</div>'+
      '<div>거리: <span class="popup-dist">'+s.dist_km.toFixed(3)+' km</span></div>';
    marker.bindPopup(basePopup);
    marker.on('popupopen', function(){
      var date = document.getElementById('dateSelect').value;
      var line = '';
      if(date){
        var v = SNOW_DATA.stationData[String(s.id)] ? SNOW_DATA.stationData[String(s.id)][date] : null;
        line = '<div style="margin-top:4px;border-top:1px solid #eee;padding-top:4px;">'+date+' 신적설: <b style="color:#1F51FF">'+(v!=null ? v.toFixed(1)+'cm' : '자료없음')+'</b></div>';
      }
      marker.setPopupContent(basePopup + line);
    });
    marker._baseRadius = 5;
    markerById[s.id] = marker;
  });

  // ---------- 강조(하이라이트) & 표시/숨김 ----------
  var highlightLayer = L.layerGroup().addTo(map);
  var snowLabelLayer = L.layerGroup().addTo(map);
  var NEON_PALETTE = ['#39FF14','#00FFFF','#FF00FF','#FF3131','#1F51FF','#FF6EC7','#CCFF00','#FF9500','#9D00FF','#00FF7F','#FFFB00','#00B3FF'];
  var visibleStationIds = null; // null = 전체 표시

  function showSnowLabels(stationList){
    snowLabelLayer.clearLayers();
    var date = document.getElementById('dateSelect').value;
    if(!date) return;
    (stationList||[]).forEach(function(s){
      var rec = SNOW_DATA.stationData[String(s.id)];
      var v = rec ? rec[date] : null;
      if(v == null) return;
      L.marker([s.lat, s.lon], {opacity:0, interactive:false})
        .bindTooltip(v.toFixed(1)+'cm', {permanent:true, direction:'top', className:'snow-label', offset:[0,-6]})
        .addTo(snowLabelLayer);
    });
  }

  var GRAY_COLOR = '#c9c4b3';
  function grayOutExcept(idList){
    var idSet = {};
    (idList||[]).forEach(function(id){ idSet[id] = true; });
    Object.keys(markerById).forEach(function(idStr){
      var id = Number(idStr);
      var m = markerById[id];
      var keepColor = (idList === null) || idSet[id];
      m.setStyle({ fillColor: keepColor ? m._baseColor : GRAY_COLOR, fillOpacity: keepColor ? 0.9 : 0.45 });
    });
    visibleStationIds = idList;
  }

  function clearMapHighlight(){
    highlightLayer.clearLayers();
    snowLabelLayer.clearLayers();
    Object.keys(markerById).forEach(function(idStr){
      var m = markerById[idStr];
      m.setRadius(5); m.setStyle({weight:1});
    });
    grayOutExcept(null);
  }

  // 지사 선택: 관할 노선 전체를 노란색 하나로 강조, 해당 지사 관측소 외에는 회색 처리
  function highlightForBranch(stationList, routeSegments){
    highlightLayer.clearLayers();
    (routeSegments||[]).forEach(function(seg){
      var latlngs = seg.coords.map(function(c){return [c[1], c[0]];});
      L.polyline(latlngs, {color:'#FFE400', weight:6, opacity:0.95}).addTo(highlightLayer);
    });
    Object.keys(markerById).forEach(function(idStr){ markerById[idStr].setRadius(5); markerById[idStr].setStyle({weight:1}); });
    (stationList||[]).forEach(function(s){
      var m = markerById[s.id];
      if(m){ m.setRadius(8); m.setStyle({weight:2}); }
    });
    grayOutExcept((stationList||[]).map(function(s){return s.id;}));
    showSnowLabels(stationList);
  }

  // 본부 선택: 하위 지사별로 서로 다른 형광색, 본부 소속 외 관측소는 회색 처리
  function highlightForHQ(hq){
    highlightLayer.clearLayers();
    var allIds = [];
    var allStationsForLabels = [];
    hq.branches.forEach(function(br, idx){
      var color = NEON_PALETTE[idx % NEON_PALETTE.length];
      (br.routeSegments||[]).forEach(function(seg){
        var latlngs = seg.coords.map(function(c){return [c[1], c[0]];});
        L.polyline(latlngs, {color:color, weight:6, opacity:0.95}).addTo(highlightLayer);
      });
      br.stations.forEach(function(s){ allIds.push(s.id); allStationsForLabels.push(s); });
    });
    Object.keys(markerById).forEach(function(idStr){ markerById[idStr].setRadius(5); markerById[idStr].setStyle({weight:1}); });
    allIds.forEach(function(id){
      var m = markerById[id];
      if(m){ m.setRadius(8); m.setStyle({weight:2}); }
    });
    grayOutExcept(allIds);
    showSnowLabels(allStationsForLabels);
  }

  function clearHighlightRows(){
    document.querySelectorAll('.br-row.active,.st-row.active,.hq-row.active').forEach(function(el){
      el.classList.remove('active');
    });
  }

  function dimOtherSwatches(activeBrRow){
    document.querySelectorAll('.color-swatch').forEach(function(el){
      el.style.background = '#d8d5c8';
    });
    if(activeBrRow){
      var sw = activeBrRow.querySelector('.color-swatch');
      if(sw) sw.style.background = '#FFE400';
    }
  }

  function restoreSwatchColors(){
    document.querySelectorAll('.color-swatch').forEach(function(el){
      el.style.background = el.dataset.color;
    });
  }

  function zoomToLatLngs(latlngs, fallbackAnchor){
    if(latlngs && latlngs.length){
      map.fitBounds(L.latLngBounds(latlngs), {padding:[40,40], maxZoom:13});
    } else if(fallbackAnchor){
      map.setView([fallbackAnchor[0], fallbackAnchor[1]], 11);
    }
  }

  function routeLatLngs(routeSegments){
    var out = [];
    (routeSegments||[]).forEach(function(seg){
      seg.coords.forEach(function(c){ out.push([c[1], c[0]]); });
    });
    return out;
  }

  function flyToStation(s){
    map.flyTo([s.lat, s.lon], 14, {duration:0.6});
    var m = markerById[s.id];
    if(m) m.openPopup();
  }

  // ---------- 트리 렌더링 ----------
  var treeEl = document.getElementById('tree');
  var filterText = '';
  var openBranch = null; // { row, children } 현재 펼쳐진 지사 하나만 추적
  var openHQ = null; // { row, children } 현재 펼쳐진 본부 하나만 추적

  function matchesFilter(text){
    return !filterText || (text||'').toLowerCase().indexOf(filterText) !== -1;
  }
  function stationMatches(s){
    return matchesFilter(s.name) || matchesFilter(s.road) || matchesFilter(String(s.id));
  }

  function buildTree(){
    treeEl.innerHTML = '';
    openBranch = null;
    openHQ = null;
    rowRegistry = {};
    snowBadgeRegistry = {};
    stationRowRegistry = {};

    HIERARCHY.hq.forEach(function(hq){
      var hqBranchesVisible = hq.branches.filter(function(br){
        if(!filterText) return true;
        if(matchesFilter(hq.name) || matchesFilter(br.name)) return true;
        return br.stations.some(stationMatches);
      });
      if(filterText && hqBranchesVisible.length === 0) return;

      var hqRow = document.createElement('div');
      hqRow.className = 'hq-row';
      hqRow.innerHTML =
        '<span class="chev">▶</span><span class="hq-name">'+hq.name+' 본부</span>'+
        '<span class="count-badge'+(hq.count===0?' zero':'')+'">'+hq.count+'</span>';

      var hqChildren = document.createElement('div');
      hqChildren.className = 'hq-children';

      var branchesToRender = filterText ? hqBranchesVisible : hq.branches;
      branchesToRender.forEach(function(br){
        var colorIdx = hq.branches.indexOf(br);
        var swatchColor = NEON_PALETTE[colorIdx % NEON_PALETTE.length];
        var brRow = document.createElement('div');
        brRow.className = 'br-row';
        var brKey = hq.name + '|||' + br.name;
        var radiusTag = br.radiusKm && br.radiusKm !== 5 ? ' <span style="color:#c97a2b;font-size:10px;">('+br.radiusKm+'km)</span>' : '';
        brRow.innerHTML =
          '<span class="chev">▶</span>'+
          '<span class="color-swatch" data-color="'+swatchColor+'" style="background:'+swatchColor+'"></span>'+
          '<span class="br-name">'+br.name+' 지사'+radiusTag+'</span>'+
          '<span class="snow-badge none" style="display:none;"></span>'+
          '<span class="count-badge'+(br.count===0?' zero':'')+'">'+br.count+' 대</span>';
        rowRegistry[brKey] = {hqRow: hqRow, brRow: brRow, hq: hq, br: br};
        snowBadgeRegistry[brKey] = brRow.querySelector('.snow-badge');

        var brChildren = document.createElement('div');
        brChildren.className = 'br-children';

        var stationsToRender = filterText ? br.stations.filter(stationMatches) : br.stations;
        if(stationsToRender.length === 0){
          var empty = document.createElement('div');
          empty.className = 'empty-msg';
          empty.textContent = '반경 8km 이내에도 적설관측소 없음';
          brChildren.appendChild(empty);
        } else {
          stationsToRender.forEach(function(s){
            var stRow = document.createElement('div');
            stRow.className = 'st-row';
            stRow.dataset.id = s.id;
            var band = s.dist_km<=3?1:(s.dist_km<=6?2:3);
            stRow.innerHTML =
              '<span class="st-name">'+s.name+'<span class="id">#'+s.id+(s.addr?(' · '+s.addr):'')+' · '+s.road+'</span></span>'+
              '<span class="st-snow" style="font-family:var(--mono);font-weight:700;color:#1F51FF;margin-right:8px;"></span>'+
              '<span class="st-dist dist-band-'+band+'">'+s.dist_km.toFixed(3)+' km</span>';
            stationRowRegistry[s.id] = stRow.querySelector('.st-snow');
            stRow.addEventListener('click', function(e){
              e.stopPropagation();
              clearHighlightRows();
              stRow.classList.add('active');
              flyToStation(s);
            });
            brChildren.appendChild(stRow);
          });
        }

        brRow.addEventListener('click', function(e){
          e.stopPropagation();
          var isOpen = brRow.classList.contains('open');
          if(isOpen){
            brRow.classList.remove('open');
            brChildren.classList.remove('expanded');
            openBranch = null;
            clearHighlightRows();
            clearMapHighlight();
            restoreSwatchColors();
            return;
          }
          // 다른 지사가 열려 있으면 먼저 접기
          if(openBranch && openBranch.row !== brRow){
            openBranch.row.classList.remove('open');
            openBranch.children.classList.remove('expanded');
          }
          brRow.classList.add('open');
          brChildren.classList.add('expanded');
          openBranch = { row: brRow, children: brChildren };
          clearHighlightRows();
          brRow.classList.add('active');
          dimOtherSwatches(brRow);
          highlightForBranch(br.stations, br.routeSegments);
          var latlngs = routeLatLngs(br.routeSegments);
          if(latlngs.length){
            zoomToLatLngs(latlngs, br.anchor);
          } else {
            zoomToLatLngs(br.stations.map(function(s){return [s.lat,s.lon];}), br.anchor);
          }
        });

        hqChildren.appendChild(brRow);
        hqChildren.appendChild(brChildren);
      });

      hqRow.addEventListener('click', function(){
        var isOpen = hqRow.classList.contains('open');
        if(isOpen){
          hqRow.classList.remove('open');
          hqChildren.classList.remove('expanded');
          openHQ = null;
          clearHighlightRows();
          clearMapHighlight();
          restoreSwatchColors();
          map.setView([36.4, 127.9], 7); // 전체 지도로 축소
          return;
        }
        // 다른 본부가 열려 있으면 먼저 접기
        if(openHQ && openHQ.row !== hqRow){
          openHQ.row.classList.remove('open');
          openHQ.children.classList.remove('expanded');
        }
        hqRow.classList.add('open');
        hqChildren.classList.add('expanded');
        openHQ = { row: hqRow, children: hqChildren };
        clearHighlightRows();
        hqRow.classList.add('active');
        restoreSwatchColors();
        var allStations = [];
        var allSegments = [];
        hq.branches.forEach(function(br){
          allStations = allStations.concat(br.stations);
          allSegments = allSegments.concat(br.routeSegments);
        });
        highlightForHQ(hq);
        var latlngs = routeLatLngs(allSegments);
        if(latlngs.length){
          zoomToLatLngs(latlngs, null);
        } else {
          zoomToLatLngs(allStations.map(function(s){return [s.lat,s.lon];}), null);
        }
      });

      if(filterText){
        hqRow.classList.add('open');
        hqChildren.classList.add('expanded');
      }

      treeEl.appendChild(hqRow);
      treeEl.appendChild(hqChildren);
    });

    if(HIERARCHY.unclassified.length && (!filterText || HIERARCHY.unclassified.some(stationMatches) || matchesFilter('미분류'))){
      var section = document.createElement('div');
      section.className = 'unclass-section';
      var header = document.createElement('div');
      header.className = 'unclass-header';
      header.textContent = '미분류 (' + HIERARCHY.unclassified.length + ') — 관할 지사 노선정보 모호로 자동배정 실패';
      section.appendChild(header);
      var list = filterText ? HIERARCHY.unclassified.filter(stationMatches) : HIERARCHY.unclassified;
      list.forEach(function(s){
        var stRow = document.createElement('div');
        stRow.className = 'st-row';
        stRow.style.paddingLeft = '12px';
        stRow.dataset.id = s.id;
        var band = s.dist_km<=3?1:(s.dist_km<=6?2:3);
        stRow.innerHTML =
          '<span class="st-name">'+s.name+'<span class="id">#'+s.id+' · '+s.road+'</span></span>'+
          '<span class="st-dist dist-band-'+band+'">'+s.dist_km.toFixed(3)+' km</span>';
        stRow.addEventListener('click', function(){
          clearHighlightRows();
          stRow.classList.add('active');
          flyToStation(s);
        });
        section.appendChild(stRow);
      });
      treeEl.appendChild(section);
    }
    updateAllSnowBadges();
  }

  document.getElementById('searchBox').addEventListener('input', function(e){
    filterText = e.target.value.trim().toLowerCase();
    buildTree();
  });

  // ================= 신적설 데이터 모듈 =================
  var ALL_BRANCH_KEYS = [];
  HIERARCHY.hq.forEach(function(hq){
    hq.branches.forEach(function(br){ ALL_BRANCH_KEYS.push(hq.name+'|||'+br.name); });
  });

  function dateRangeStrs(y1,m1,d1,y2,m2,d2){
    var start = new Date(y1,m1-1,d1);
    var end = new Date(y2,m2-1,d2);
    var out = []; var d = new Date(start);
    while(d <= end){
      var yyyy = d.getFullYear(), mm = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
      out.push(''+yyyy+mm+dd);
      d.setDate(d.getDate()+1);
    }
    return out;
  }

  function refreshSeasonOptions(){
    var sel = document.getElementById('seasonSelect');
    var labels = Object.keys(SNOW_DATA.seasons).sort();
    var prev = sel.value;
    sel.innerHTML = labels.map(function(l){return '<option value="'+l+'">'+l+'</option>';}).join('');
    if(labels.indexOf(prev) !== -1) sel.value = prev;
    else if(labels.length) sel.value = labels[labels.length-1];
  }

  function refreshLoadedDataBar(){
    var bar = document.getElementById('loadedDataBar');
    var labels = Object.keys(SNOW_DATA.seasons).sort();
    if(labels.length === 0){ bar.innerHTML = '현재 로드된 신적설 데이터 없음'; return; }
    var chips = labels.map(function(label){
      var season = SNOW_DATA.seasons[label];
      var branchKeys = Object.keys(season.branches);
      var daysWithData = 0;
      for(var i=0;i<season.dates.length;i++){
        var found = false;
        for(var j=0;j<branchKeys.length;j++){
          if(season.branches[branchKeys[j]][i] != null){ found = true; break; }
        }
        if(found) daysWithData++;
      }
      return '<span class="season-chip"><b>'+label+'</b> · '+daysWithData+'/'+season.dates.length+'일 자료 보유</span>';
    });
    bar.innerHTML = '현재 로드된 데이터: ' + chips.join(' ');
  }

  function refreshDateOptions(){
    var allDates = {};
    Object.keys(SNOW_DATA.seasons).forEach(function(label){
      SNOW_DATA.seasons[label].dates.forEach(function(d){ allDates[d] = true; });
    });
    var sorted = Object.keys(allDates).sort();
    var sel = document.getElementById('dateSelect');
    var prev = sel.value;
    sel.innerHTML = '<option value="">일자 선택(신적설)</option>' + sorted.map(function(d){
      return '<option value="'+d+'">'+d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8)+'</option>';
    }).join('');
    if(sorted.indexOf(prev) !== -1) sel.value = prev;
  }

  function computeBranchMax(hqName, brName, date){
    if(!date) return null;
    var hq = HIERARCHY.hq.filter(function(h){return h.name===hqName;})[0];
    if(!hq) return null;
    var br = hq.branches.filter(function(b){return b.name===brName;})[0];
    if(!br) return null;
    var max = null;
    br.stations.forEach(function(s){
      var rec = SNOW_DATA.stationData[String(s.id)];
      var v = rec ? rec[date] : null;
      if(v != null && (max===null || v > max)) max = v;
    });
    return max;
  }

  function updateAllSnowBadges(){
    var date = document.getElementById('dateSelect').value;
    Object.keys(rowRegistry).forEach(function(key){
      var parts = key.split('|||');
      var val = computeBranchMax(parts[0], parts[1], date);
      var badge = snowBadgeRegistry[key];
      if(badge){
        if(!date){ badge.style.display='none'; }
        else if(val != null){ badge.textContent = val.toFixed(1)+'cm'; badge.classList.remove('none'); badge.style.display='inline-block'; }
        else { badge.textContent = '0cm'; badge.classList.add('none'); badge.style.display='inline-block'; }
      }
    });
    Object.keys(stationRowRegistry).forEach(function(idStr){
      var el = stationRowRegistry[idStr];
      var rec = SNOW_DATA.stationData[idStr];
      var v = (date && rec) ? rec[date] : null;
      el.textContent = (date && v != null) ? (v.toFixed(1)+'cm') : (date ? '-' : '');
    });
  }

  document.getElementById('dateSelect').addEventListener('change', function(){
    updateAllSnowBadges();
    // 현재 열려있는 지사가 있으면 지도 라벨도 갱신
    if(openBranch){
      var key = Object.keys(rowRegistry).filter(function(k){return rowRegistry[k].brRow===openBranch.row;})[0];
      if(key) showSnowLabels(rowRegistry[key].br.stations);
    } else if(openHQ){
      var hqKey = Object.keys(rowRegistry).filter(function(k){return rowRegistry[k].hqRow===openHQ.row;});
      var allSt = [];
      hqKey.forEach(function(k){ allSt = allSt.concat(rowRegistry[k].br.stations); });
      showSnowLabels(allSt);
    }
  });

  function openBranchByKey(key){
    var entry = rowRegistry[key];
    if(!entry) return;
    if(!entry.hqRow.classList.contains('open')) entry.hqRow.click();
    if(!entry.brRow.classList.contains('open')) entry.brRow.click();
  }

  // ---------- 연도별 신적설 표 ----------
  function buildSnowTable(){
    var label = document.getElementById('seasonSelect').value;
    var season = SNOW_DATA.seasons[label];
    var wrap = document.getElementById('snowTableWrap');
    if(!season){ wrap.innerHTML = '<div style="padding:20px;color:#888;">자료 없음</div>'; return; }
    var dates = season.dates;

    var html = '<table class="snowtable"><thead><tr><th class="row-label row-label-head">본부 / 지사</th><th class="sum-col-head">지사:합계<br>본부:평균</th>';
    dates.forEach(function(d){
      html += '<th data-col-h="'+d+'">'+d.slice(4,6)+'/'+d.slice(6,8)+'</th>';
    });
    html += '</tr></thead><tbody>';

    HIERARCHY.hq.forEach(function(hq){
      // 지사별 배열을 먼저 모아서 본부 평균 계산
      var branchArrs = hq.branches.map(function(br){
        var key = hq.name+'|||'+br.name;
        return season.branches[key] || dates.map(function(){return null;});
      });
      var hqAvgArr = dates.map(function(_, i){
        var vals = branchArrs.map(function(arr){return arr[i];}).filter(function(v){return v!=null;});
        return vals.length ? (vals.reduce(function(a,b){return a+b;},0) / vals.length) : null;
      });

      var branchSums = branchArrs.map(function(arr){ return arr.reduce(function(acc,v){ return acc + (v||0); }, 0); });
      var hqSeasonAvg = branchSums.length ? (branchSums.reduce(function(a,b){return a+b;},0) / branchSums.length) : null;
      html += '<tr class="hq-row-label"><td class="row-label">'+hq.name+' 본부(평균)</td><td class="sum-col">'+(hqSeasonAvg!=null?hqSeasonAvg.toFixed(2):'-')+'</td>';
      hqAvgArr.forEach(function(v){
        var disp = v==null ? '-' : v.toFixed(1);
        html += '<td>'+disp+'</td>';
      });
      html += '</tr>';

      hq.branches.forEach(function(br, bi){
        var key = hq.name+'|||'+br.name;
        var arr = branchArrs[bi];
        var sum = arr.reduce(function(acc,v){ return acc + (v||0); }, 0);
        html += '<tr data-branch-row="'+key+'"><td class="row-label" style="padding-left:20px;">'+br.name+'</td>';
        html += '<td class="sum-col">'+(sum>0 ? sum.toFixed(1) : '-')+'</td>';
        arr.forEach(function(v, i){
          var d = dates[i];
          var cls = v==null ? '' : (v>0 ? 'has-val' : 'zero-val');
          var disp = v==null ? '-' : v.toFixed(1);
          html += '<td class="snowcell '+cls+'" data-date="'+d+'" data-branch="'+key+'" data-col="'+i+'">'+disp+'</td>';
        });
        html += '</tr>';
      });
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    var cells = wrap.querySelectorAll('td.snowcell');
    cells.forEach(function(td){
      td.addEventListener('mouseenter', function(){
        var col = this.dataset.col;
        wrap.querySelectorAll('td[data-col="'+col+'"]').forEach(function(c){ c.classList.add('col-hl'); });
        var row = wrap.querySelector('tr[data-branch-row="'+this.dataset.branch+'"]');
        if(row) row.classList.add('row-hl');
      });
      td.addEventListener('mouseleave', function(){
        var col = this.dataset.col;
        wrap.querySelectorAll('td[data-col="'+col+'"]').forEach(function(c){ c.classList.remove('col-hl'); });
        wrap.querySelectorAll('tr.row-hl').forEach(function(r){ r.classList.remove('row-hl'); });
      });
      td.addEventListener('click', function(){
        var date = this.dataset.date;
        var key = this.dataset.branch;
        var parts = key.split('|||');
        switchTab('map');
        document.getElementById('dateSelect').value = date;
        updateAllSnowBadges();
        openBranchByKey(key);
      });
    });
  }

  document.getElementById('seasonSelect').addEventListener('change', buildSnowTable);

  // ---------- 엑셀(xlsx) 내보내기 ----------
  function exportSnowTableToXlsx(){
    var label = document.getElementById('seasonSelect').value;
    var season = SNOW_DATA.seasons[label];
    if(!season) return;
    var dates = season.dates;

    var header = ['본부/지사', '지사:합계 / 본부:평균'].concat(dates.map(function(d){
      return d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8);
    }));
    var rows = [header];

    HIERARCHY.hq.forEach(function(hq){
      var branchArrs = hq.branches.map(function(br){
        var key = hq.name+'|||'+br.name;
        return season.branches[key] || dates.map(function(){return null;});
      });
      var hqAvgArr = dates.map(function(_, i){
        var vals = branchArrs.map(function(arr){return arr[i];}).filter(function(v){return v!=null;});
        return vals.length ? (vals.reduce(function(a,b){return a+b;},0) / vals.length) : null;
      });
      var branchSums = branchArrs.map(function(arr){ return arr.reduce(function(acc,v){ return acc + (v||0); }, 0); });
      var hqSeasonAvg = branchSums.length ? (branchSums.reduce(function(a,b){return a+b;},0) / branchSums.length) : null;

      rows.push([hq.name+' 본부(평균)', hqSeasonAvg!=null?Number(hqSeasonAvg.toFixed(2)):null].concat(
        hqAvgArr.map(function(v){ return v!=null ? Number(v.toFixed(1)) : null; })
      ));

      hq.branches.forEach(function(br, bi){
        var arr = branchArrs[bi];
        var sum = arr.reduce(function(acc,v){ return acc + (v||0); }, 0);
        rows.push([br.name, Number(sum.toFixed(1))].concat(
          arr.map(function(v){ return v!=null ? Number(v.toFixed(1)) : null; })
        ));
      });
    });

    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:16},{wch:14}].concat(dates.map(function(){return {wch:9};}));
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, label.slice(0,31));
    XLSX.writeFile(wb, '신적설_'+label+'.xlsx');
  }

  document.getElementById('exportXlsxBtn').addEventListener('click', exportSnowTableToXlsx);

  refreshSeasonOptions();
  refreshDateOptions();
  buildSnowTable();

  buildTree();
}
