/*!
 * 차로차로 펫 재생기 (charo-pet.js) v1
 * 에디터에서 저장한 charo-pet.json 을 읽어 화면 하단에 캐릭터를 띄웁니다.
 * 사용법: index.html의 body 끝에 아래처럼 script 태그 한 줄을 넣습니다.
 *   script src="charo-pet.js" data-src="charo-pet.json" defer
 *   좁은 화면에서도 보이게 하려면 data-mobile="show" 를 함께 넣습니다.
 * 미리보기: CharoPet.site.play('c01'), CharoPet.site.setAuto(false)
 * 키보드 반응은 "키가 눌렸다"는 신호만 쓰며, 입력한 글자는 읽지 않습니다.
 */
(function (global) {
  'use strict';

  var PROPS = ['x', 'y', 'rot', 'sx', 'sy', 'op'];
  var DEF = { x: 0, y: 0, rot: 0, sx: 1, sy: 1, op: 1 };

  var EASE = {
    linear: function (t) { return t; },
    'in': function (t) { return t * t; },
    out: function (t) { return 1 - (1 - t) * (1 - t); },
    inout: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    back: function (t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    step: function () { return 0; }
  };

  function sampleTrack(keys, t) {
    if (!keys || !keys.length) return null;
    if (t <= keys[0].t) return keys[0].v;
    for (var i = 0; i < keys.length - 1; i++) {
      var a = keys[i], b = keys[i + 1];
      if (t < b.t) {
        var span = b.t - a.t;
        var u = span > 0 ? (t - a.t) / span : 1;
        var f = (EASE[a.e] || EASE.linear)(u);
        return a.v + (b.v - a.v) * f;
      }
    }
    return keys[keys.length - 1].v;
  }

  // 그림 바꿔치기: 마지막으로 지난 키의 그림으로, f(초) 동안 이전 그림에서 서서히 바뀜
  function sampleImg(keys, t, restImg, loop) {
    if (!keys || !keys.length) return null;
    var cur = -1;
    for (var i = 0; i < keys.length; i++) { if (keys[i].t <= t + 1e-6) cur = i; else break; }
    if (cur < 0) {
      if (!loop) return null;
      var lv = keys[keys.length - 1].v;
      return { img: lv, prev: lv, mix: 1 };
    }
    var k = keys[cur];
    var prev = cur > 0 ? keys[cur - 1].v : (loop ? keys[keys.length - 1].v : restImg);
    var mix = k.f > 0 ? Math.min(1, (t - k.t) / k.f) : 1;
    return { img: k.v, prev: prev, mix: mix };
  }

  function findClip(p, id) {
    if (!id || !p.clips) return null;
    for (var i = 0; i < p.clips.length; i++) if (p.clips[i].id === id) return p.clips[i];
    return null;
  }
  function findPart(p, id) {
    if (!id) return null;
    for (var i = 0; i < p.parts.length; i++) if (p.parts[i].id === id) return p.parts[i];
    return null;
  }

  // 한 동작의 t초 시점 값 (키가 있는 속성만)
  function clipPose(p, clip, t) {
    var out = {};
    if (!clip || !clip.tracks) return out;
    for (var pid in clip.tracks) {
      if (!Object.prototype.hasOwnProperty.call(clip.tracks, pid)) continue;
      var part = findPart(p, pid);
      if (!part) continue;
      var tr = clip.tracks[pid], o = {}, any = false;
      for (var j = 0; j < PROPS.length; j++) {
        var v = sampleTrack(tr[PROPS[j]], t);
        if (v !== null) { o[PROPS[j]] = v; any = true; }
      }
      var im = sampleImg(tr.img, t, part.rest.img || 0, !!clip.loop);
      if (im) { o.img = im; any = true; }
      if (any) out[pid] = o;
    }
    return out;
  }

  // 키가 없는 속성은 기본값(변화 없음)으로 채움
  function offsetsFrom(p, pose) {
    var off = {};
    for (var i = 0; i < p.parts.length; i++) {
      var part = p.parts[i], src = pose[part.id] || {}, o = {};
      for (var j = 0; j < PROPS.length; j++) {
        var k = PROPS[j];
        o[k] = src[k] != null ? src[k] : DEF[k];
      }
      o.img = src.img || null;
      off[part.id] = o;
    }
    return off;
  }

  // 기본 자세 + 동작 변화량 = 최종 자세
  function finalPose(p, off, follow) {
    var res = {};
    for (var i = 0; i < p.parts.length; i++) {
      var part = p.parts[i], r = part.rest;
      var o = (off && off[part.id]) || DEF;
      var f = {
        x: r.x + o.x, y: r.y + o.y, rot: r.rot + o.rot,
        sx: r.sx * o.sx, sy: r.sy * o.sy, op: r.op * o.op
      };
      var im = o.img;
      f.img = im ? im.img : (r.img || 0);
      f.prev = im ? im.prev : f.img;
      f.mix = im ? im.mix : 1;
      if (follow && part.follow && part.follow.on) {
        f.x += follow.x * (part.follow.max || 0);
        f.y += follow.y * (part.follow.max || 0);
      }
      res[part.id] = f;
    }
    return res;
  }

  // 2D 변환 행렬 [a,b,c,d,e,f] (canvas setTransform 순서)
  function mul(A, B) {
    return [
      A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
      A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
      A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]
    ];
  }
  function inv(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-12) det = det < 0 ? -1e-12 : 1e-12;
    var a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
    return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
  }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function localM(f, pv) {
    var r = f.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    var a = c * f.sx, b = s * f.sx, cc = -s * f.sy, d = c * f.sy;
    return [a, b, cc, d, f.x - (a * pv.x + cc * pv.y), f.y - (b * pv.x + d * pv.y)];
  }
  function worldMatrices(p, pose) {
    var W = {}, busy = {};
    function get(id) {
      if (W[id]) return W[id];
      var part = findPart(p, id);
      if (!part || busy[id] || !pose[id]) return [1, 0, 0, 1, 0, 0];
      busy[id] = true;
      var L = localM(pose[id], part.pivot);
      var m = part.parent && findPart(p, part.parent) ? mul(get(part.parent), L) : L;
      busy[id] = false;
      W[id] = m;
      return m;
    }
    for (var i = 0; i < p.parts.length; i++) get(p.parts[i].id);
    return W;
  }

  // 그림 캐시
  var cache = {};
  function imgFor(p, assetId) {
    var src = p.assets && p.assets[assetId];
    if (!src) return null;
    var e = cache[assetId];
    if (!e || e._src !== src) {
      e = new Image();
      e._src = src;
      e.src = src;
      cache[assetId] = e;
    }
    return e.complete && e.naturalWidth ? e : null;
  }
  function preload(p) {
    var ids = [];
    p.parts.forEach(function (pt) { pt.images.forEach(function (v) { if (ids.indexOf(v.asset) < 0) ids.push(v.asset); }); });   // 같은 그림을 여러 파츠가 써도 한 번만
    return Promise.all(ids.map(function (id) {
      return new Promise(function (res) {
        var src = p.assets && p.assets[id];
        if (!src) return res();
        var e = cache[id];
        if (!e || e._src !== src) { e = new Image(); e._src = src; cache[id] = e; e.src = src; }
        if (e.complete && e.naturalWidth) return res();
        e.onload = e.onerror = function () { res(); };
      });
    }));
  }

  function drawVariant(ctx, p, part, idx, alpha) {
    if (alpha <= 0.001) return;
    var v = part.images[idx] || part.images[0];
    if (!v) return;
    var im = imgFor(p, v.asset);
    if (!im) return;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(im, v.x || 0, v.y || 0, v.w || im.naturalWidth, v.h || im.naturalHeight);
  }

  function render(ctx, p, fp, W, view) {
    for (var i = 0; i < p.parts.length; i++) {
      var part = p.parts[i], f = fp[part.id];
      if (!f || f.op <= 0.001) continue;
      var m = mul(view, W[part.id]), cl = part.clip;
      if (cl && W[cl.part]) {   // clip: 다른 파츠 좌표의 사각형 안쪽만 그림(예: 길통이 팔의 얼굴 앞 부분만 다시 그리기)
        var mc = mul(view, W[cl.part]);
        ctx.save(); ctx.setTransform(mc[0], mc[1], mc[2], mc[3], mc[4], mc[5]);
        ctx.beginPath(); ctx.rect(cl.rect[0], cl.rect[1], cl.rect[2], cl.rect[3]); ctx.clip();
      }
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      if (f.prev !== f.img && f.mix < 1) {
        drawVariant(ctx, p, part, f.prev, f.op * (1 - f.mix));
        drawVariant(ctx, p, part, f.img, f.op * f.mix);
      } else {
        drawVariant(ctx, p, part, f.img, f.op);
      }
      if (cl && W[cl.part]) ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  function inHours(h, a, b) {
    a = +a; b = +b;
    if (a === b) return false;
    return a < b ? (h >= a && h < b) : (h >= a || h < b);
  }

  // ---------- 반응 규칙 엔진 ----------
  // 한 번 재생: click, spam(연타), hover, near(가까이·머무름), flick(휙), type(타자, 이어치기)
  // 가끔 혼자: random (묶음에서 하나, 평소 동작 중일 때만)
  // 상태: idle(가만히), time(시간대 + 잠깐 가만히) — 조건이 맞는 동안 반복, 시작/끝 동작
  function now() { return (global.performance && performance.now()) || Date.now(); }
  function Engine(p, opt) { this.p = p; this.opt = opt || {}; this.auto = true; this.reset(); }
  Engine.prototype.reset = function () {
    var n = now();
    this.t = n; this.lastInput = n; this.one = null; this.layer = undefined; this.stateId = undefined;
    this.layerStart = n; this.blend = null; this.last = null; this.nextRand = {}; this.lastPick = {}; this.played = {};
    this.hour = null; this.follow = { x: 0, y: 0 }; this.followT = { x: 0, y: 0 }; this.side = 'right';
    this.clicks = []; this.ptr = null; this.nearArmed = true; this.nearSince = null; this.cool = {}; this.typeUntil = 0;
  };
  Engine.prototype.input = function () { this.lastInput = Math.max(this.t, now()); };
  Engine.prototype.skipIdle = function (sec) { this.lastInput -= sec * 1000; };
  Engine.prototype.setAuto = function (on) {
    this.auto = !!on;
    if (!on) { this.one = null; this.stateId = null; this._snap(); }
    this.input();
  };
  Engine.prototype._snap = function () {
    if (!this.last) return;
    var c = {};
    for (var pid in this.last) {
      var o = this.last[pid], part = findPart(this.p, pid);
      c[pid] = {};
      for (var j = 0; j < PROPS.length; j++) c[pid][PROPS[j]] = o[PROPS[j]];
      c[pid].img = o.img ? o.img.img : (part ? part.rest.img || 0 : 0);
    }
    this.blend = { start: this.t, from: c };
  };
  Engine.prototype._start = function (id, o) {
    o = o || {};
    this._snap();
    this.one = { id: id, start: this.t, weak: !!o.weak, locked: !!o.locked, sustain: !!o.sustain,
      loopFrom: +o.loopFrom || 0, endId: o.endId || null, manual: !!o.manual };
    this.played[id] = this.t;
  };
  // 미리보기용 수동 재생: 무엇이든 끊고 바로 재생
  Engine.prototype.play = function (id) {
    if (!findClip(this.p, id)) return false;
    this.input(); this.t = now();
    this._start(id, { locked: true, manual: true, endId: findClip(this.p, id).previewNext });
    return true;
  };
  Engine.prototype.rule = function (ev) {
    var rules = this.p.rules || [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.event === ev && (findClip(this.p, r.clip) || findClip(this.p, r.clipLeft))) return r;
    }
    return null;
  };
  Engine.prototype.sleeping = function () {
    if (this.stateId == null) return false;
    var rules = this.p.rules || [];
    for (var i = 0; i < rules.length; i++) if (rules[i].id === this.stateId) return true;
    return false;
  };
  Engine.prototype.trigger = function (ev) {
    var wasSleeping = this.sleeping();
    this.input();
    if (!this.auto || wasSleeping) return false;   // 졸 때의 입력은 깨우기만
    var r = this.rule(ev);
    if (!r) return false;
    var t = now();
    if (r.cooldown && this.cool[r.id] != null && t - this.cool[r.id] < r.cooldown * 1000) return false;
    var weak = ev === 'hover' || ev === 'near';
    var id = (this.side === 'left' && findClip(this.p, r.clipLeft)) ? r.clipLeft : r.clip;
    if (!findClip(this.p, id)) id = r.clipLeft;
    if (this.one) {
      if (this.one.locked) return false;
      if (this.one.id === id && !r.restart) return false;
      if (!this.one.weak && !r.interrupt) return false;
      if (this.one.weak && weak) return false;
    }
    this.cool[r.id] = t; this.t = t;
    this._start(id, { weak: weak, locked: !!r.lock, sustain: ev === 'type' && !!r.sustain, loopFrom: r.loopFrom, endId: r.end });
    return true;
  };
  // 마우스 위치: 캐릭터 중심 기준 화면 px, unit = 무대 1칸이 화면에서 몇 px인지
  Engine.prototype.pointer = function (dx, dy, unit) {
    var t = now(), prev = this.ptr;
    this.ptr = { x: dx, y: dy, t: t, su: Math.sqrt(dx * dx + dy * dy) / (unit || 1) };
    var len = Math.sqrt(dx * dx + dy * dy), su = this.ptr.su;
    var k = Math.min(1, su / (this.opt.followRange || 600));
    if (len < 1) { this.followT.x = 0; this.followT.y = 0; }
    else { this.followT.x = dx / len * k; this.followT.y = dy / len * k; }
    if (this.sleeping()) { this.input(); return; }
    this.input();
    if (!(this.one && this.one.locked)) this.side = dx < 0 ? 'left' : 'right';
    var fr = this.rule('flick');
    if (fr && prev) {
      var dt = (t - prev.t) / 1000;
      if (dt > 0.004 && dt < 0.12) {
        var v = Math.sqrt((dx - prev.x) * (dx - prev.x) + (dy - prev.y) * (dy - prev.y)) / dt;
        if (v >= (+fr.speed || 2600)) this.trigger('flick');
      }
    }
    var nr = this.rule('near');
    if (nr) {
      var R = +nr.dist || 260;
      if (su < R) { if (this.nearSince == null) this.nearSince = t; }
      else if (su > R * 1.4) { this.nearArmed = true; this.nearSince = null; }
      else this.nearSince = null;
    }
  };
  Engine.prototype.click = function () {
    if (this.sleeping()) { this.input(); return; }
    this.input();
    var sr = this.rule('spam');
    if (sr) {
      var t = now(), win = (+sr.window || 1.6) * 1000;
      this.clicks.push(t);
      this.clicks = this.clicks.filter(function (c) { return t - c <= win; });
      if (this.clicks.length >= (+sr.count || 4)) { this.clicks = []; if (this.trigger('spam')) return; }
    }
    this.trigger('click');
  };
  Engine.prototype.key = function () {
    if (this.sleeping()) { this.input(); return; }
    var r = this.rule('type');
    this.typeUntil = now() + ((r && +r.gap) || 0.8) * 1000;
    if (this.one && this.one.sustain) { this.input(); return; }
    this.trigger('type');
  };
  Engine.prototype.stateRule = function () {
    if (!this.auto) return null;
    var hour = this.hour != null ? this.hour : new Date().getHours();
    var idle = (this.t - this.lastInput) / 1000;
    var rules = this.p.rules || [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!findClip(this.p, r.clip)) continue;
      if (r.event === 'idle' && idle >= (+r.sec || 30)) return r;
      if (r.event === 'time' && inHours(hour, r.from, r.to) && idle >= (r.sec != null ? +r.sec : 8)) return r;
    }
    return null;
  };
  function followMode(clip, tl) {
    if (!clip || !clip.follow) return null;
    if (typeof clip.follow === 'string') return clip.follow;
    var m = null;
    for (var i = 0; i < clip.follow.length; i++) if (clip.follow[i][0] <= tl + 1e-6) m = clip.follow[i][1];
    return m || 'on';
  }
  Engine.prototype.update = function (t) {
    this.t = t;
    var p = this.p, self = this, rules = p.rules || [], base = p.baseClip || null;
    var idleSec = (t - this.lastInput) / 1000;
    if (this.auto) {
      // 가까이 머무름
      var nr = this.rule('near');
      if (nr && this.nearArmed && this.nearSince != null && t - this.nearSince >= (+nr.dwell || 0) * 1000) {
        if (this.trigger('near')) this.nearArmed = false;
        else if (!(this.one)) this.nearArmed = false;
      }
      rules.forEach(function (r) {
        if (r.event !== 'random') return;
        var mn = Math.max(0.5, +r.min || 3), mx = Math.max(mn, +r.max || mn);
        var next = self.nextRand[r.id];
        if (next == null) { self.nextRand[r.id] = t + 1000 * (mn + Math.random() * (mx - mn)); return; }
        if (t < next) return;
        self.nextRand[r.id] = t + 1000 * (mn + Math.random() * (mx - mn));
        if (self.one || self.layer !== base || idleSec < (+r.quiet || 0)) return;
        var pool = (r.clips && r.clips.length ? r.clips : [r.clip]).filter(function (id) {
          var c = findClip(p, id);
          if (!c) return false;
          if (self.opt.reduce && c.big) return false;
          if (c.cool && self.played[id] != null && t - self.played[id] < c.cool * 1000) return false;
          return true;
        });
        if (pool.length > 1) pool = pool.filter(function (id) { return id !== self.lastPick[r.id]; });
        if (!pool.length) return;
        var tot = 0; pool.forEach(function (id) { tot += findClip(p, id).weight != null ? +findClip(p, id).weight : 1; });
        var x = Math.random() * tot, pick = pool[0];
        for (var i = 0; i < pool.length; i++) { x -= findClip(p, pool[i]).weight != null ? +findClip(p, pool[i]).weight : 1; if (x <= 0) { pick = pool[i]; break; } }
        self.lastPick[r.id] = pick;
        self._start(pick, { weak: true });
      });
    }
    var sr = this.stateRule(), sid = sr ? sr.id : null;
    if (this.stateId !== undefined && sid !== this.stateId) {
      var prevR = null;
      for (var i = 0; i < rules.length; i++) if (rules[i].id === this.stateId) prevR = rules[i];
      if (sr && sr.enter && findClip(p, sr.enter)) this._start(sr.enter, { locked: true });
      else if (prevR && prevR.exit && findClip(p, prevR.exit) && this.auto) this._start(prevR.exit, { locked: true });
    }
    this.stateId = sid;
    var layer = sr ? sr.clip : base;
    if (layer !== this.layer) {
      if (this.layer !== undefined) this._snap();
      this.layer = layer; this.layerStart = t;
    }
    var clip = findClip(p, layer), pose = {}, ltl = 0;
    if (clip) {
      var el = (t - this.layerStart) / 1000;
      ltl = clip.loop ? (clip.dur > 0 ? el % clip.dur : 0) : Math.min(el, clip.dur);
      pose = clipPose(p, clip, ltl);
    }
    var oc = null, otl = 0;
    if (this.one) {
      oc = findClip(p, this.one.id);
      otl = (t - this.one.start) / 1000;
      if (oc && this.one.sustain && otl >= oc.dur && t < this.typeUntil) {
        this.one.start = t - this.one.loopFrom * 1000; otl = this.one.loopFrom;   // 입력이 이어지면 이어서
      }
      if (!oc || otl >= oc.dur) {
        var endId = (this.one.sustain || this.one.manual) ? this.one.endId : null, man = this.one.manual;
        this._snap(); this.one = null; oc = null;
        if (endId && findClip(p, endId)) {   // 이어지는 동작 (타자 마무리, 미리보기 연속 재생)
          this._start(endId, { manual: man, locked: man, endId: man ? findClip(p, endId).previewNext : null });
          oc = findClip(p, endId); otl = 0;
        }
      }
      if (oc) {
        var op = clipPose(p, oc, otl);
        for (var pid in op) {
          var dst = pose[pid] || (pose[pid] = {});
          for (var k in op[pid]) dst[k] = op[pid][k];
        }
      }
    }
    // 눈 따라보기: 동작마다(시간별로) 켜짐 on / 멈춤 hold / 정면 center
    var fm = (oc && followMode(oc, otl)) || (clip && followMode(clip, ltl)) || 'on';
    if (fm !== 'hold') {
      var tx = fm === 'center' ? 0 : this.followT.x, ty = fm === 'center' ? 0 : this.followT.y;
      this.follow.x += (tx - this.follow.x) * 0.12;
      this.follow.y += (ty - this.follow.y) * 0.12;
    }
    var off = offsetsFrom(p, pose);
    if (this.blend) {
      var u = (t - this.blend.start) / 160;
      if (u >= 1) this.blend = null;
      else {
        u = EASE.out(u);
        for (var id in off) {
          var a = this.blend.from[id];
          if (!a) continue;
          for (var j = 0; j < PROPS.length; j++) {
            var pr = PROPS[j];
            off[id][pr] = a[pr] + (off[id][pr] - a[pr]) * u;
          }
          var part = findPart(p, id);
          var cur = off[id].img ? off[id].img.img : (part ? part.rest.img || 0 : 0);
          if (a.img !== cur && !(off[id].img && off[id].img.mix < 1)) off[id].img = { img: cur, prev: a.img, mix: u };
        }
      }
    }
    this.last = off;
    if (this.opt.reduce) {   // 애니메이션 줄이기: 이동·회전·늘어남을 작게
      var res = {};
      for (var rid in off) {
        var o2 = off[rid];
        res[rid] = { x: o2.x * 0.25, y: o2.y * 0.25, rot: o2.rot * 0.35, sx: 1 + (o2.sx - 1) * 0.35, sy: 1 + (o2.sy - 1) * 0.35, op: o2.op, img: o2.img };
      }
      return res;
    }
    return off;
  };

  // ---------- 사이트 하단 표시 ----------
  function store(key, val) {
    try {
      if (val === undefined) return global.localStorage.getItem(key);
      global.localStorage.setItem(key, val);
    } catch (e) { return null; }
    return null;
  }

  function SitePet(p, opt) {
    opt = opt || {};
    var d = {}, base = { size: 140, corner: 'right', margin: 16, hideOnMobile: true, closable: true };
    for (var k in base) d[k] = base[k];
    for (k in (p.display || {})) d[k] = p.display[k];
    if (opt.mobile === 'show') d.hideOnMobile = false;
    if (opt.mobile === 'hide') d.hideOnMobile = true;
    if (d.hideOnMobile && global.matchMedia && matchMedia('(max-width: 640px)').matches) return;
    var reduce = !!(global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    var side = d.corner === 'left' ? 'left' : 'right', other = side === 'left' ? 'right' : 'left';
    var size = Math.max(40, +d.size || 140), margin = Math.max(0, +d.margin || 0);
    var self = this;

    var wrap = document.createElement('div');
    wrap.setAttribute('data-charo-pet', '');
    wrap.style.cssText = 'position:fixed;bottom:' + margin + 'px;' + side + ':' + margin + 'px;z-index:9999;width:' +
      size + 'px;height:' + size + 'px;pointer-events:none;';
    var cv = document.createElement('canvas');
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', p.name || '캐릭터');
    // 캐릭터가 그려진 곳에서만 클릭을 받고, 투명한 곳은 아래 페이지로 통과
    cv.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;cursor:pointer;touch-action:manipulation;';
    wrap.appendChild(cv);

    var btnCss = 'position:absolute;top:' + Math.round(size * 0.12) + 'px;' + other + ':-4px;width:24px;height:24px;border-radius:50%;' +
      'border:1px solid rgba(0,0,0,.18);background:#fff;color:#333;font:16px/1 system-ui,sans-serif;' +
      'cursor:pointer;pointer-events:auto;opacity:0;transition:opacity .2s;padding:0;';
    var close = null, tab = null, hidden = false, overChar = false;
    if (d.closable) {
      close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('aria-label', '캐릭터 숨기기');
      close.textContent = '×';
      close.style.cssText = btnCss;
      wrap.appendChild(close);
      close.addEventListener('pointerenter', function () { close.style.opacity = '1'; });
      close.addEventListener('focus', function () { close.style.opacity = '1'; });
      close.addEventListener('blur', function () { close.style.opacity = '0'; });
      tab = document.createElement('button');
      tab.type = 'button';
      tab.textContent = (p.name || '캐릭터') + ' 보이기';
      tab.style.cssText = 'position:fixed;bottom:' + margin + 'px;' + side + ':' + margin + 'px;z-index:9999;' +
        'display:none;padding:6px 12px;border-radius:999px;border:1px solid rgba(0,0,0,.18);background:#fff;' +
        'color:#333;font:13px/1.2 system-ui,sans-serif;cursor:pointer;';
      document.body.appendChild(tab);
    }
    document.body.appendChild(wrap);

    var ctx = cv.getContext('2d');
    var dpr = 1;
    function resize() {
      dpr = Math.min(3, global.devicePixelRatio || 1);
      cv.width = Math.round(size * dpr);
      cv.height = Math.round(size * dpr);
    }
    resize();
    global.addEventListener('resize', resize);

    var eng = new Engine(p, { reduce: reduce });
    var S = p.stage || { w: 400, h: 400 };
    var raf = 0;

    function draw(t) {
      var off = eng.update(t);
      var sc = size / Math.max(S.w, S.h) * dpr;
      var view = [sc, 0, 0, sc, (cv.width - S.w * sc) / 2, (cv.height - S.h * sc) / 2];
      var fp = finalPose(p, off, eng.follow);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      render(ctx, p, fp, worldMatrices(p, fp), view);
    }
    function loop(t) {
      if (hidden || document.hidden) { raf = 0; return; }
      draw(t);
      raf = requestAnimationFrame(loop);
    }
    function wake() { if (!raf && !hidden && !document.hidden) raf = requestAnimationFrame(loop); }

    function setHidden(h) {
      hidden = h;
      wrap.style.display = h ? 'none' : '';
      if (tab) tab.style.display = h ? 'block' : 'none';
      store('charoPetHidden', h ? '1' : '0');
      if (!h) { eng.input(); wake(); }
    }
    if (close) {
      close.addEventListener('click', function (e) { e.stopPropagation(); setHidden(true); });
      tab.addEventListener('click', function () { setHidden(false); });
      if (store('charoPetHidden') === '1') setHidden(true);
    }

    function hit(cx, cy) {
      var r = cv.getBoundingClientRect();
      if (cx < r.left || cy < r.top || cx >= r.right || cy >= r.bottom) return false;
      try {
        var x = Math.floor((cx - r.left) / r.width * cv.width), y = Math.floor((cy - r.top) / r.height * cv.height);
        return ctx.getImageData(x, y, 1, 1).data[3] > 24;
      } catch (e) { return true; }
    }
    document.addEventListener('pointermove', function (e) {
      if (hidden) return;
      var r = cv.getBoundingClientRect();
      eng.pointer(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), r.width / Math.max(S.w, S.h));
      var h = hit(e.clientX, e.clientY);
      if (h !== overChar) {
        overChar = h;
        cv.style.pointerEvents = h ? 'auto' : 'none';
        if (close) close.style.opacity = h ? '1' : '0';
        if (h) eng.trigger('hover');
      }
    }, { passive: true });
    document.addEventListener('pointerdown', function (e) {
      if (hidden || e.pointerType === 'mouse') return;
      if (hit(e.clientX, e.clientY)) { if (close) close.style.opacity = '1'; eng.click(); }
    }, { passive: true });
    document.addEventListener('keydown', function () { eng.key(); });
    global.addEventListener('scroll', function () { eng.input(); }, { passive: true });
    cv.addEventListener('click', function (e) { if (e.pointerType && e.pointerType !== 'mouse') return; eng.click(); });
    document.addEventListener('visibilitychange', wake);
    wake();

    // 미리보기·개발용
    this.engine = eng;
    this.play = function (id) { if (hidden) setHidden(false); wake(); return eng.play(id); };
    this.setAuto = function (on) { eng.setAuto(on); };
    this.clips = function () { return (p.clips || []).map(function (c) { return { id: c.id, name: c.name, dur: c.dur, loop: !!c.loop }; }); };
    this.data = p;
    global.CharoPet.site = this;
    try { document.dispatchEvent(new CustomEvent('charopet:ready', { detail: this })); } catch (e) {}
  }

  function mount(script) {
    var src = script.getAttribute('data-src') || 'charo-pet.json';
    var opt = { mobile: script.getAttribute('data-mobile') };
    function start() {
      fetch(src, { cache: 'no-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (p) { return preload(p).then(function () { new SitePet(p, opt); }); })
        .catch(function (e) { console.warn('[charo-pet] 캐릭터 파일을 불러오지 못했습니다:', src, e); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  // 캐릭터 데이터를 이 파일 안에 함께 넣은 한 파일 버전(window.CHARO_PET_EMBED)
  function mountData(p, opt) {
    function start() { preload(p).then(function () { new SitePet(p, opt || {}); }); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  global.CharoPet = {
    PROPS: PROPS, DEF: DEF, EASE: EASE, sampleTrack: sampleTrack, sampleImg: sampleImg,
    findClip: findClip, findPart: findPart, clipPose: clipPose, offsetsFrom: offsetsFrom,
    finalPose: finalPose, mul: mul, inv: inv, apply: apply, localM: localM,
    worldMatrices: worldMatrices, imgFor: imgFor, preload: preload, render: render,
    Engine: Engine, mount: mount, mountData: mountData, inHours: inHours, site: null
  };

  var cs = document.currentScript;
  if (cs && cs.hasAttribute('data-src')) mount(cs);
  else if (global.CHARO_PET_EMBED) mountData(global.CHARO_PET_EMBED, { mobile: cs && cs.getAttribute('data-mobile') });
})(window);
