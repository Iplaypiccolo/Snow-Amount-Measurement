# CLAUDE.md — 제설 업무 시스템 (이 파일은 Claude Code 가 매번 가장 먼저 읽는 안내판입니다)

> 길게 쓰지 않습니다. 자세한 내용은 `docs/` 에 있고, 여기에는 **위치와 규칙**만 적습니다.

## 이 프로젝트
고속도로 제설 업무용 웹 시스템. 화면은 **GitHub Pages**(정적 파일), 서버는 **Supabase**(서울, 무료 플랜).
- 저장소: `Iplaypiccolo/Snow-Amount-Measurement` (공개) · 사이트: `https://iplaypiccolo.github.io/Snow-Amount-Measurement/`
- Supabase 프로젝트: `snow-support` (ref `yzwbnohzhnctdvufntig`). **다른 프로젝트 `Snowpath`(도쿄)는 건드리지 않는다.**
- 화면 4개: 강설량 측정 / 기관별 관할 고속도로 / 예보 격자 편입(grid.edit 권한) / 장비 지원. 관리 콘솔 `/admin/`.

## 사용자와 역할 분담 (중요)
- 사용자는 **비전공자**입니다. 한국어로, 새 용어는 풀어서 설명하세요. 확인하지 못한 것을 "확인했다"고 쓰지 마세요(확인한 것/못 한 것을 구분).
- 새 기능과 큰 설계는 사용자가 **claude.ai 채팅**에서 Claude 와 합니다. **그 채팅은 이 세션의 내용을 볼 수 없습니다.**
- 그래서 Claude Code 는 **① 실제 서버·사이트 연결 확인 ② 버그 조사·수정 ③ 시험 실행** 위주로 합니다. 설계 변경이 필요해 보이면 구현하지 말고 `docs/handoff.md` 에 **"제안"** 으로 적고 멈추세요.
- **푸시할 때마다 `docs/handoff.md` "기록" 맨 위에 그 푸시의 내 커밋들을 묶은 항목 하나를 쓰고, 끝에 `— ✍ Claude Code 작성` 서명.** 채팅 Claude 가 쓴 항목은 고치지 않는다. 규칙은 handoff.md 맨 위. 이것이 채팅 쪽 Claude 가 알 수 있는 유일한 통로입니다.

## 명령어
```
python tools/run_all_tests.py            # 전체 시험 (약 5분, 병렬). --fast 는 화면 시험 제외, --only 이름 으로 일부만
```
필요: Node 22 · Python 3 · `pip install playwright` · `playwright install chromium`. 개별 시험은 `tests/` 에 있고 파일 맨 위에 실행법이 적혀 있습니다.
인터넷이 막힌 곳에서는 환경변수 `LEAFLET_DIR`·`XLSX_FILE` 로 지도 라이브러리 위치를 지정합니다(보통 필요 없음).

## 구조 지도
| 위치 | 내용 |
|---|---|
| `index.html`, `boot.js`, `app.js` | 첫 화면(로그인 잠금 → 강설량 측정). **CSP 때문에 HTML 안에 스크립트를 쓰지 않음**(시작 코드는 `boot.js`). 저장 후 새로고침 없이 `refreshHierarchyViews` 로 다시 그림 |
| `auth/` | `auth.js` 로그인·토큰 보관, `events.js` 변경 이력 읽기/저장(+`saveJurisdiction` 저장·승인 한 번에), `gate.js` 로그인 잠금 화면, `snow.js` 적설 요약본 읽기 |
| `jurisdiction/` | 관할 탭: `core.js`(계산, 화면 없음), `ui.js`, `requests.js`(지사의 구간 변경 요청) |
| `grid/` | 예보 격자 편입 탭 (`core.js` 계산, `ui.js`) |
| `admin/` | 관리 콘솔: 계정 관리, **산하기관 아이디 관리**(비밀번호 일괄 설정·권한·순서·새 아이디/추천 13개), **적설 자료(메모장 txt → 서버)**, 접속 로그. 탭은 권한대로 |
| `equipment/` | 장비 지원 화면(iframe). **서버 저장**(장비·날짜별 경로·기준일자·지사 요청). `?sample=1` = 샘플 시연. 규칙 `docs/equipment-rules.md`. **index.html 의 칸(id) 구성을 바꾸면 `<meta name="ui-version">` 과 `app.js` 의 `UI_VERSION` 을 함께 올릴 것**(배포 직후 예전 틀이 남은 브라우저가 한 번 새로 받음) |
| `data/*.json` | 기본(baseline) 자료. 구간 1,011 · 관측소 260 · 격자 1,070쌍. `*_changes.json` 은 서버 장애 때의 비상용(비어 있음). **적설 파일(`snow_data.json`)은 서버로 옮긴 뒤 지움** — 적설은 서버 `snow_daily`→`snapshots`, 시험은 `tests/fixtures/snow_sample.json` |
| `supabase/migrations/` | DB 변경 SQL(01~36; 15 세부 권한, 16~22 장비 서버, 23~26·29 특보, 27·28 예상 적설·강수, 30 안 쓰는 권한 삭제, 31 적설 요약본 시즌별, 32 적설 자동 수집, 33 기상현황 직접입력, 34 최저기온, 35 확정 줄 잠금, 36 예보 24시간 창 매시 이동). `functions/` Edge Function 6개(`account-admin`, `import-reference`, `import-snow`, `collect-warnings`, `collect-forecast`, `collect-snow`). `tests/*.sql` 권한 시험(`rls_test.sql`·`equipment_save_test.sql`·`warnings_test.sql`·`forecast_test.sql` 등) |
| `tests/` | 자동 시험. `_sb_mock.py` 는 **가짜 Supabase 서버**(실제 서버에 접속하지 않고 화면을 시험) |
| `tools/` | 자료 만들기·검증 도구. GIS 원본(`highway_links.gpkg` 등)은 저장소에 없음. `check_gaps_against_source.py` = 끊긴 구간을 원본과 대조 |
| `.github/workflows/` | `supabase-keepalive.yml` 월·목 서버 깨우기(비밀값 없음, `keepalive()` 함수) — `docs/server-keepalive.md`. 이 폴더를 올리려면 토큰에 workflow 권한 필요 |
| `docs/` | **`decisions.md`(결정 이력)**, `supabase-design.md`(서버 전체), `jurisdiction-rules.md`, `grid-assign-rules.md`, `admin-console.md`, `login-gate.md` |

## 작업 규칙 (사용자와 합의한 것)
1. **js·css 를 고쳤으면 `python tools/stamp_assets.py` 로 꼬리표(`?v=`)를 갱신**한다(안 하면 사용자 브라우저가 최대 10분 예전 파일을 씀 — `tests/test_asset_stamps.py` 가 막음). **반영 전에 `tools/run_all_tests.py` 를 통과**시킨다. 변경은 작게 나눠 커밋하고, 커밋 메시지는 한국어로 "무엇을, 왜"를 쓴다.
2. 반영은 **`main` 에 직접**(브랜치·PR 없음). 데스크톱 앱이 작업 사본(worktree)에서 일했더라도 끝낼 때: `git fetch` → `git rebase origin/main` → 시험 통과 → `git push origin HEAD:main`.
   채팅 쪽 Claude 도 같은 `main` 에 푸시하므로 **일 시작 전에 항상 `git pull`**, 푸시 전에 `git fetch` 로 새 커밋이 있는지 확인.
3. **되돌리기 어려운 일은 실행 전에 사용자에게 먼저 알리고 확인**받는다: 데이터 삭제(`delete`/`truncate`/`drop`), 권한 규칙(RLS) 변경, 계정 대량 변경·비밀번호 변경, 변경 이력 수정, DB 구조 변경. **실행할 SQL 을 먼저 보여 준다.**
4. 서버(Supabase)에 한 변경은 **`supabase/migrations/` 에 SQL 파일로도 남긴다**(파일 번호 이어서). 무료 플랜은 **자동 백업이 없으므로** 위험한 변경 전에 필요한 자료를 내려받아 둔다.
5. 권한은 **화면이 아니라 서버(DB)가 지킨다.** 화면에서 버튼을 숨기는 것은 편의 기능일 뿐이다.
6. 결정이나 알게 된 함정은 `docs/decisions.md` 에 날짜와 함께 추가한다.

## 하지 말 것
- **비밀값을 파일·커밋·대화에 쓰지 않는다**: GitHub 토큰, Supabase `service_role` 키, 계정 비밀번호. (화면 코드의 `sb_publishable_…` 키는 원래 공개용이라 괜찮음.) 비밀번호가 필요하면 환경변수로만.
- `data/sections.json` 의 **지사 소속 구간 686개의 좌표·길이를 바꾸지 않는다**(관측소 배정이 달라짐. `tests/test_sections_continuity.py` 가 지문으로 막음).
- **구간 번호(S0001…)·지사 번호(B001…)를 바꾸지 않는다**: 저장된 변경 이력·요청이 번호를 가리킨다.
- 이미 저장된 `jurisdiction_events`·`grid_events` 줄을 고치거나 지우지 않는다(DB 가 막고 있음. 우회하지 말 것).
- 운영 DB 에 시험용 자료를 남기지 않는다. 시험 SQL 은 마지막에 일부러 오류를 내어 되돌리는 방식이다.

## 서버 요약 (자세한 것은 `docs/supabase-design.md`)
- 로그인: 아이디 → `<아이디>@snow-support.invalid` 가짜 이메일. 계정: `admin-01`, `admin-02`, 지사 59개 `ex<지사 로마자>`. 역할 `admin`/`branch`/`equip`/`hq`/`viewer` + 계정별 세부 권한 `perms`(표 `permissions`, 서버는 `private.has_perm`). 관리자는 모든 권한. 가입은 막혀 있고 계정은 관리자만 만든다. **관리자 계정은 새로 만들지 않는다**(사용자 결정).
- 관할·격자 **변경은 이력(이벤트)으로 쌓고**, 화면이 기본 자료 위에 다시 적용해 계산한다(`JurisCore.reapply`). 기본 자료 읽기는 아직 파일(DB 사본과 동일)이며 DB 읽기로 옮기는 것이 다음 단계.
- 지사의 구간 변경 요청: 표 `jurisdiction_requests`(지사 요청 → 관리자 알림 → 이동 준비 → 저장 시 승인). 요청과 연결된 저장은 DB 함수 `save_jurisdiction` 이 **저장+승인을 한 번에**(하나라도 안 되면 전부 취소).
- 관할 이력 값은 DB 트리거가 검사(신설 기관 번호 `B000` 형식, 이름 1~20자·`< > " ' & \``금지, 실제 본부 이름).
- 특보: pg_cron 이 10분마다(매시 01·11…분) **받을 필요가 있을 때만**(`private.warn_needed()` = 만든 기준일자(기준일자 +2일까지)에 확정을 기다리는 지사가 있음, 기준일자를 만들면 바로 한 번) Edge Function `collect-warnings` 호출(기상청 API허브 `wrn_now_data_new`, 키는 함수 비밀값 `KMA_AUTH_KEY` 에만). 종류 스위치 `settings('warnings')` = `{"kinds":"all"}`(확인용, 지금) / `{"kinds":["대설"]}` → `warnings_active`/`warnings_history`. 지사 ↔ 특보구역 = `section_zones`(고속도로 구간 × 시·군·구 경계, `tools/build_section_zones.py` → `data/section_zones.json`) + 관리자 손질 `branch_zone_overrides`. 화면은 `warning_status()`, 확정하면 트리거가 `round_requests.warn_*` 에 고정.
- 예상 적설·강수: 특보와 같은 조건일 때 발표(02·05…시) 15·25·35·45분 + 기준일자를 만들 때 `collect-forecast` → 단기예보 격자 `nph-dfs_shrt_grd` SNO·PCP 1시간치 24번씩 = 48번(요청 1번 = 전국 1시간치) → 지사 격자(`private.grid_effective()` = grid_assign + grid_events 변경, 924칸)만 `forecast_hours` → 격자별 24시간 합 `forecast_cells`, 지사 최댓값 `branch_forecast`. 확정하면 `round_requests.fc_*` 고정. 화면: 장비 지원 '강설 [적설|강수]', 강설량 측정 '기관별 24시간 예보' 탭(`forecast/ui.js`, `forecast_grid()`).
- 적설: 원자료 `snow_daily`(관측소 680곳, 결측 -99.9 제외) → 요약본 `snapshots('snow')` → 화면이 지사별 최댓값 계산. 넣기는 관리 콘솔 '적설 자료' 탭(Edge Function `import-snow`, plan→load).
- 일회용 시작 토큰(`settings` 의 `bootstrap_token`, 15분)으로 Edge Function 을 부르는 방식이 있다. 쓸 때는 `pg_net` 을 `extensions` 스키마에 잠시 만들고 **끝나면 반드시 지운다**.

## 알려진 함정
- Supabase API 경로는 **WHERE 없는 DELETE 를 막는다**(`where true` 필요).
- 서버는 한 번에 **1,000줄**까지만 돌려준다 → `auth/events.js` 가 나눠 읽는다.
- `raw.githubusercontent.com` 은 몇 분 캐시한다 → 서버 이전 함수를 부를 때 **커밋 번호(`ref`)를 지정**한다.
- 신설 기관(`addBranch`)의 `id` 는 기관 번호(이름표, 순서 아님)다. 예전 버그로 번호 없이 저장된 줄(서버 줄 `10`=영암, `11`=민자)은 **읽을 때 `B060`·`B061` 로 바꿔 읽는다**(`auth/events.js` 의 `LEGACY_BRANCH`, 이력 안의 '10'·'11' 도 함께) — 지우지 말 것. 서버 `branches` 에도 B060·B061 로 등록됨.
- 신설 기관을 저장하면 DB 트리거가 `branches` 에 자동 등록(본부 이동도 반영). 기관 순서는 번호가 아니라 이력의 `after`(신설 시)·`orderBranch`(나중에)로 정한다 — 중간에 끼워도 다른 번호는 그대로.
- `tools/add_unassigned_sections.py` 를 다시 돌리면 IC/JC 에서 구간이 끊긴다 → 이어서 `tools/fill_section_gaps.py`, 그다음 `tools/reference_check.py` 로 DB 와 비교.
- 첫 화면·관리 콘솔에 CSP 가 있어 화면 시험의 `wait_for_function(문자열)` 이 막힌다 → 첫 화면 시험 페이지는 `bypass_csp=True`, CSP 자체는 `t_csp_blocks_injected_script` 가 확인.
- 일회용 시작 토큰을 settings 에 넣는 일은 Claude Code 안전 장치가 막는다 → 서버 함수 호출은 관리자 로그인(관리 콘솔)으로.
- 화면 시험은 가짜 서버를 쓴다. **실제 서버와 사이트에서는 아직 확인하지 못한 것이 많다**(`docs/handoff.md` 의 "확인 필요" 목록).
