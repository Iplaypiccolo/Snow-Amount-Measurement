/* 로그인 인트로 배치표 (2026-10-17 개정 콘티). 시간은 모두 같은 시간축(초)입니다.
   0.00     티라와 그 오른편의 타로타로만 서 있음(다른 친구들은 아직 안 보임)
   0.37~0.90 타로타로가 티라의 불을 보고 잠깐 움찔(표정 B·느낌표) → 1.30~ 고무공 도움닫기(키 50%) → 1.74 첨다니를 따라 점프해 티라 위쪽으로
   0.30~    길통이·첨다니·차로차로·도로덕이 지평선의 한 점(소실점)에서 나와 같은 땅 위를 달려오며 커짐(원근)
   0.30~2.30 티라: 불 뿜기 → 뜨거워 → '아 맞다' → 머리만 돌려 입으로 거꾸로 팻말 꺼냄
   1.55     첨다니가 먼저 도착 → 1.62 고무공 점프 → 차로차로 위쪽(뒤)에 자리
   2.30~3.90 친구들이 도착하는 그 순간 슬로모션: '환영합니다!' 문구·배경·폭죽·색종이(welcome-fx.js)
   3.90~    착지·균형 회복(길통이·차로차로·도로덕은 오른쪽으로 비켜 줌) → 타로타로 오른쪽으로 휘어 하강, 4.16 왼바퀴·4.28 오른바퀴 착지 → 4.45 엣헴
            4.30 첨다니가 공중제비로 티라 왼쪽으로
   5.15~5.85 함께 작아지며 아래 줄로: 첨다니–티라–타로타로–길통이–차로차로–도로덕 → 로그인 대기
   place 키: [시각, 발 x, 발 y, 표시 키, 이징, 앞뒤(클수록 앞)] — 논리 화면 1000×600 */
(function (global) {
  'use strict';
  var DUR = 6.3, SLOW = [2.30, 3.90], LS = 0.55, L0 = 5.15, L1 = 5.85;
  var VP = [500, 336];                      // 소실점 = 겨울 배경 그림의 도로가 모이는 점(배경을 무대 폭에 맞춰 그렸을 때)
  var ROW = 585, X = { chumdani: 280, tira: 358, tarotaro: 430, giltong: 521, charocharo: 634, doroduck: 740 };   // 6인: 보이는 그림 사이 14px, 줄 가운데 = 문구 가운데(505)
  // 대형(슬로모션) 자리 = 구도 참고 사진의 위치·크기를 무대 좌표로 옮긴 값(사진 폭 1670 → 무대 1000, 배경과 같은 비율).
  // 가로는 티라 왼쪽 끝~도로덕 오른쪽 끝의 가운데가 '환영합니다!' 가운데(505)에 오도록 DX만큼 함께 옮김
  var DX = -65;   // 측정: 티라 왼쪽 끝 249 ~ 도로덕 오른쪽 끝 890 → 가운데 570 → 505로
  function at(x, y, h) { return [x + DX, y, h]; }
  var GY = 540;   // 모두가 발을 딛는 땅의 높이(수평선 하나)
  var F = { tira: at(296, GY, 133), giltong: at(431, GY, 290), charocharo: at(630, GY, 157), doroduck: at(785, GY, 113),
            chumLane: at(512, GY, 137), chumPerch: at(684, 390, 137) };
  // 슬로모션 뒤 '자리 잡기'(첨다니가 티라 왼쪽에 내려앉을 자리를 위해 다 같이 조금 오른쪽으로)
  var S = { tira: at(296, GY, 133), giltong: at(530, GY, 290), charocharo: at(720, GY, 157), doroduck: at(860, GY, 113), chumSide: at(195, GY, 137) };   // 6인: 티라는 제자리, 길통이·차로차로·도로덕이 오른쪽으로 비켜 타로타로 착지 자리를 냄
  var HF = { chumdani: 69, tira: 66, tarotaro: 74,   // 티라: 처음 크기(133)에 타로타로와 같은 비율(74/150≈0.49)
              giltong: 113, charocharo: 76, doroduck: 82 };   // 최종 줄 크기(로그인 대기)
  // 원근 달리기: 지평선의 점(배율 s0)에서 제자리(배율 1)까지. 배율은 지수적으로 커짐(일정한 속도로 다가올 때처럼)
  function run(f, t0, t1, s0, drift, dm) {   // dm: 같은 거리일 때 앞뒤 순서 보정(길통이가 차로차로 날개 앞)
    dm = dm || 1;
    var k = [[0, VP[0], VP[1], 0, 'linear', 0], [t0 - 0.001, VP[0], VP[1], 0, 'linear', 0]];
    for (var t = t0; t <= t1 + 1e-9; t = Math.round((t + 0.05) * 1000) / 1000) {
      var u = Math.min(1, (t - t0) / (t1 - t0)), s = Math.exp(Math.log(s0) * (1 - u));
      k.push([t, VP[0] + (f[0] - VP[0]) * s, VP[1] + (f[1] - VP[1]) * s, f[2] * s, 'linear', s * dm]);
    }
    if (drift) {   // 슬로모션 동안 아주 조금 더 앞으로 밀려옴(멈춰 서지 않은 느낌)
      var d = drift; k.push([SLOW[1], VP[0] + (f[0] - VP[0]) * d, VP[1] + (f[1] - VP[1]) * d, f[2] * d, 'out', d * dm]);
      k.push([4.30, f[0], f[1], f[2], 'inout', dm]);
    }
    return k;
  }
  function makeWay(keys, id, dep) {   // 3.90~4.40 길통이·차로차로·도로덕이 오른쪽으로 비켜 줌(타로타로 착지 자리) → 4.98까지 그대로
    var s2 = S[id]; return keys.filter(function (k) { return k[0] <= SLOW[1] + 1e-9; }).concat([[4.40, s2[0], s2[1], s2[2], 'out', dep], [4.98, s2[0], s2[1], s2[2], 'linear', dep]]);
  }
  function settle(id, f, dep) {   // 4.30~4.98 자리 잡기
    var s2 = S[id]; return [[4.30, f[0], f[1], f[2], 'linear', dep], [4.98, s2[0], s2[1], s2[2], 'inout', dep]];
  }
  function lineup(id, f, hEnd, dep) {
    var h = HF[id];
    return [[L0, f[0], f[1], f[2], 'inout', dep], [L1, X[id], ROW, h, 'inout', dep], [DUR, X[id], ROW, h, 'linear', dep]];
  }
  // 첨다니: 0.30 출발 → 1.55 먼저 도착(자기 줄: 길통이와 차로차로 사이) → 1.62 점프 시작(납작) → 1.86~2.16 공중 → 차로차로 위쪽(뒤)
  var cl = F.chumLane, cp = F.chumPerch, cs = S.chumSide;
  var chum = run(cl, 0.30, 1.55, 0.03).concat([[1.84, cl[0], cl[1], cl[2], 'linear', 1]]);
  for (var i = 1; i <= 6; i++) {           // 포물선(위로 높이 솟았다 차로차로 뒤쪽 자리에 내려앉음)
    var u = i / 6, x = cl[0] + (cp[0] - cl[0]) * u, y = cl[1] + (cp[1] - cl[1]) * u - 4 * 150 * u * (1 - u);
    chum.push([1.86 + 0.30 * u, x, y, cl[2] + (cp[2] - cl[2]) * u, 'linear', u < 1 ? 1 : 0.4]);
  }
  chum.push([4.30, cp[0], cp[1], cp[2], 'linear', 0.4]);
  // 4.30~4.98 공중제비로 친구들 머리 위를 넘어 티라 왼쪽에 착지
  for (var j = 1; j <= 8; j++) {
    var v = j / 8, x2 = cp[0] + (cs[0] - cp[0]) * v, y2 = cp[1] + (cs[1] - cp[1]) * v - 4 * 240 * v * (1 - v);   // 티라 머리 위로 충분히 높게
    chum.push([4.30 + 0.68 * v, x2, y2, cp[2] + (cs[2] - cp[2]) * v, 'linear', 2]);
  }
  chum = chum.concat(lineup('chumdani', cs, null, 0.3));
  // 타로타로: 티라 오른편에 서 있다가(불 보고 움찔) 1.74 점프 → 티라 위쪽(길통이 왼편 뒤) 환영 → 3.90 오른쪽으로 휘어 하강 → 4.16 착지
  // 바깥 층(place)은 발 위치·표시 키만. 웅크림·기울기·한쪽 바퀴 착지·표정은 캐릭터 동작(tt_intro)에서.
  var TT = { start: [335, GY, 150], perch: [216, GY - 133, 150], land: [338, GY, 145], side: [342, GY, 145] }, TD = 0.85;   // 앞뒤: 티라(1.1)·길통이(1.05, 도착 직전 포함)·첨다니·차로차로 뒤
  function ttPlace() {
    var a = TT.start, b = TT.perch, c = TT.land, k = [[0, a[0], a[1], a[2], 'linear', 0.85], [1.74, a[0], a[1], a[2], 'linear', 0.85]]   // 0.85: 달려와 옆에 서는 첨다니보다 뒤;
    for (var i = 1; i <= 8; i++) {          // 1.74~2.30 포물선(위로 솟았다 티라 위 자리로)
      var u = i / 8; k.push([1.74 + 0.56 * u, a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u - 4 * 70 * u * (1 - u), a[2] + (b[2] - a[2]) * u, 'linear', TD]);
    }
    k.push([SLOW[1], b[0] + 3, b[1] - 2, b[2], 'inout', TD]);   // 슬로모션 중 2~3px만 진행
    for (var j = 1; j <= 6; j++) {          // 3.90~4.16 오른쪽으로 휘어 내려옴(티라 머리·팻말 위를 지나지 않게 먼저 오른쪽으로)
      var v = j / 6, bx = b[0] + 3, by = b[1] - 2, cx = bx + 150, cy = by - 15;   // 2차 베지어 조절점: 오른쪽 위
      var x = (1 - v) * (1 - v) * bx + 2 * v * (1 - v) * cx + v * v * c[0], y = (1 - v) * (1 - v) * by + 2 * v * (1 - v) * cy + v * v * c[1];
      k.push([3.90 + 0.26 * v, x, y, b[2] + (c[2] - b[2]) * v, v < 1 ? 'linear' : 'in', TD]);
    }
    return k;
  }
  var base = '../';
  var cast = [
    { id: 'chumdani', name: '첨다니', file: base + 'chumdani/chumdani.json', anchor: [200, 283], stageH: 167, idle: 'c_idle',
      segs: [{ t0: 0.30, t1: 1.62, clip: 'c_run_i', rate: 1.3 }, { t0: 1.62, t1: 2.42, clip: 'c_jump_i' }, { t0: SLOW[0], t1: SLOW[1], clip: 'c_welcome', rate: 2 },
             { t0: 4.22, t1: 5.32, clip: 'c_flip', rate: 1.6 }],
      moves: [[0.30, 1.55, '원근 달리기(먼저 도착)'], [1.62, 2.16, '점프 → 차로차로 뒤'], [2.16, 4.30, '대형(차로차로 뒤)'], [4.30, 4.98, '공중제비 → 티라 왼쪽'], [5.15, 5.85, '정렬·축소']],
      place: chum, reducedSegs: [],
      reducedPlace: [[0, cp[0], cp[1], cp[2], 'linear', 0.4], [4.30, cp[0], cp[1], cp[2], 'linear', 0.4], [4.98, cs[0], cs[1], cs[2], 'inout', 0.3]].concat(lineup('chumdani', cs, null, 0.3)) },
    { id: 'giltong', name: '길통이', file: base + 'giltong/giltong.json', anchor: [200, 351], stageH: 285, idle: 'g_idle',
      segs: [{ t0: 0.30, t1: SLOW[0], clip: 'g_run_i' }, { t0: SLOW[0], t1: SLOW[1], clip: 'g_welcome', rate: 2 }, { t0: SLOW[1], t1: 4.50, clip: 'g_finish', rate: 1 }],
      moves: [[0.30, SLOW[0], '원근 달리기'], [SLOW[0], SLOW[1], '대형'], [SLOW[1], 4.40, '오른쪽으로 비켜 주기(타로타로 자리)'], [5.15, 5.85, '정렬·축소']],
      place: makeWay(run(F.giltong, 0.30, SLOW[0], 0.03, 1.02, 1.05), 'giltong', 1.05).concat(lineup('giltong', S.giltong, null, 1.05)), reducedSegs: [],
      reducedPlace: [[0].concat(F.giltong, ['linear', 1.05])].concat(settle('giltong', F.giltong, 1.05), lineup('giltong', S.giltong, null, 1.05)) },
    { id: 'tira', name: '티라', file: base + 'tira_v3/tira_v3.json', anchor: [200, 382], stageH: 274, idle: 't_idle', hold: true,
      segs: [{ t0: 0, t1: DUR, clip: 't_intro' }], reducedSegs: [{ t0: 0, t1: DUR, clip: 't_intro_r' }],
      steps: [[0.30, 0.82, '불 뿜기·뜨거워 ><'], [0.98, 1.20, '아 맞다!'], [1.20, 1.92, '머리 돌려 등 뒤 물기'], [1.92, 2.30, '꺼내서 펼치기'], [2.30, 2.55, '거꾸로 환영 · 읽기 박자'], [2.55, 3.90, '판만 흔들림 → 안정'], [3.95, 4.76, '팻말 다시 등 뒤로']],
      moves: [[0, 4.30, '제자리(대형 왼쪽)'], [4.30, 4.98, '자리 잡기'], [5.15, 5.85, '정렬·축소']],
      place: [[0].concat(F.tira, ['linear', 1.1])].concat(settle('tira', F.tira, 1.1), lineup('tira', S.tira, null, 1.1)) },
    { id: 'tarotaro', name: '타로타로', file: base + 'tarotaro/tarotaro.json', anchor: [200, 385], stageH: 280.8, idle: 'tt_idle',
      segs: [{ t0: 0, t1: DUR, clip: 'tt_intro' }], reducedSegs: [{ t0: 0, t1: DUR, clip: 'tt_intro_r' }],
      steps: [[0.37, 0.90, '불 보고 움찔 · 느낌표 (표정 B)'], [1.30, 1.74, '고무공 도움닫기(키 50%까지 납작)'], [1.74, 2.30, '점프 (표정 A)'], [2.30, 3.90, '슬로모션 환영 · 빵긋'], [4.16, 4.30, '왼바퀴 → 오른바퀴 착지'], [4.45, 4.85, '엣헴 (표정 C)']],
      moves: [[0, 1.74, '티라 오른편'], [1.74, 2.30, '점프 → 티라 위'], [2.30, 3.90, '대형(티라 위·길통이 왼편)'], [3.90, 4.16, '오른쪽으로 휘어 하강'], [4.30, 4.98, '자리 잡기'], [5.15, 5.85, '정렬·축소']],
      place: ttPlace().concat([[4.30].concat(TT.land, ['linear', TD]), [4.98].concat(TT.side, ['inout', TD])], lineup('tarotaro', TT.side, null, TD)),
      reducedPlace: [[0, TT.perch[0], TT.perch[1] + 8, TT.perch[2], 'linear', TD], [4.30, TT.perch[0], TT.perch[1] + 8, TT.perch[2], 'linear', TD],   // 기울이지 않은 정면이라 번개가 조금 더 높음 → 8px 아래
         [4.98].concat(TT.side, ['inout', TD])].concat(lineup('tarotaro', TT.side, null, TD)) },
    { id: 'charocharo', name: '차로차로', file: base + 'charo-pet.json', anchor: [200, 370], stageH: 231, idle: 'c_breath',
      segs: [{ t0: 0, t1: DUR, clip: 'i_charo' }], reducedSegs: [{ t0: 0, t1: DUR, clip: 'i_charo_r' }],
      moves: [[0.30, SLOW[0], '원근 달리기'], [SLOW[0], SLOW[1], '대형'], [SLOW[1], 4.40, '오른쪽으로 비켜 주기(타로타로 자리)'], [5.15, 5.85, '정렬·축소']],
      steps: [[0.30, 1.98, '통통 달리기'], [1.98, 2.12, '웅크림'], [2.12, 2.30, '폴짝·파닥 (표정 B)'], [2.30, 3.90, '슬로모션 비행'], [3.90, 4.30, '착지 (표정 A)'], [4.50, 4.73, '날개 정리']],
      place: makeWay(run(F.charocharo, 0.30, SLOW[0], 0.03, 1.02), 'charocharo', 1).concat(lineup('charocharo', S.charocharo, null, 1)),
      reducedPlace: [[0].concat(F.charocharo, ['linear', 1])].concat(settle('charocharo', F.charocharo, 1), lineup('charocharo', S.charocharo, null, 1)) },
    { id: 'doroduck', name: '도로덕', file: base + 'doroduck/doroduck.json', anchor: [200, 354], stageH: 231, idle: 'd_idle',
      segs: [{ t0: 0.30, t1: SLOW[0], clip: 'd_run_i' }, { t0: SLOW[0], t1: SLOW[1], clip: 'd_welcome', rate: 2 }, { t0: SLOW[1], t1: 4.75, clip: 'd_finish_i', rate: 1 }],
      moves: [[0.30, SLOW[0], '원근 달리기'], [SLOW[0], SLOW[1], '대형'], [SLOW[1], 4.40, '오른쪽으로 비켜 주기(타로타로 자리)'], [5.15, 5.85, '정렬·축소']],
      place: makeWay(run(F.doroduck, 0.30, SLOW[0], 0.03, 1.02, 1.02), 'doroduck', 1.02).concat(lineup('doroduck', S.doroduck, null, 1.02)), reducedSegs: [],
      reducedPlace: [[0].concat(F.doroduck, ['linear', 1.02])].concat(settle('doroduck', F.doroduck, 1.02), lineup('doroduck', S.doroduck, null, 1.02)) }
  ];
  var phases = [[0, '티라·타로타로 · 친구들 출발 전', '티라와 그 오른편의 타로타로만 서 있고 다른 친구들은 아직 지평선 너머(안 보임).'],
                [0.3, '친구들 달려옴 · 티라 불 뿜기', '네 친구가 지평선의 한 점에서 나와 같은 땅 위를 달려오며 점점 커짐. 티라는 신나서 불을 뿜다 뜨거워 ><. 타로타로는 불을 보고 잠깐 움찔(15도 돌아본 놀란 얼굴·느낌표, 0.90초에 끝).'],
                [1.2, '티라 팻말 꺼내기', "티라가 '아 맞다!' 하고 머리만 돌려 등 뒤 팻말을 입으로 물어 꺼냄(아랫몸통은 고정)."],
                [1.62, '첨다니 고무공 점프', '먼저 도착한 첨다니가 옆으로 납작했다가 위로 쭉 펴지며 점프해 차로차로 위쪽 뒤에 자리. 타로타로도 고무공처럼 양옆으로 크게 납작했다가 튕겨 따라 뛰어 티라 위쪽(길통이 왼편 뒤)으로.'],
                [2.12, '차로차로 폴짝', '차로차로가 멈추지 않고 달리던 그대로 폴짝. 땅에서 떨어지는 순간 표정 B(신나서 질끈).'],
                [2.3, '환영 슬로모션', "친구들이 도착하는 그 순간부터 느리게. '환영합니다!' 문구·겨울 배경·폭죽·색종이가 나타나고, 티라의 거꾸로 '환영'이 0.25초 멈춰 보임."],
                [3.9, '착지 · 팻말 다시 넣기', '효과가 사라지고 모두 균형을 되찾음. 티라는 팻말을 다시 등 뒤로, 도로덕은 팻말을 내림. 길통이·차로차로·도로덕이 오른쪽으로 비켜 주고, 타로타로가 그 틈으로 내려와 왼바퀴→오른바퀴 차례로 착지.'],
                [4.3, '첨다니 공중제비 → 티라 옆', '첨다니가 친구들 머리 위로 공중제비를 돌아 티라 왼쪽에 착지. 타로타로는 그 아래에서 짧게 엣헴(표정 C) 후 다시 빵긋.'],
                [5.15, '정렬 · 축소', '여섯이 함께 작아지며 아래 줄로: 첨다니–티라–타로타로–길통이–차로차로–도로덕.'],
                [5.85, '로그인 대기로', '정렬한 자리에서 대기 동작으로 이어짐(이후 로그인 화면).']];
  global.CharoIntroCast = { duration: DUR, cast: cast, phases: phases, lineupRow: ROW, lineupX: X, slow: SLOW, vanishingPoint: VP, formation: F, settle: S, DX: DX, tarotaro: TT };
})(window);
