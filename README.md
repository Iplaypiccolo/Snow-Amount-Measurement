# 고속도로 인접 적설관측소 지도

한국도로공사 59개 지사 관할 고속도로 구간(전국표준노드링크 기반)과, 그 인근 기상청 공식 적설관측지점의 신적설 데이터를 보여주는 웹사이트입니다.

## 구조

```
index.html              페이지 골격 (데이터는 fetch로 불러옴). 맨 위 탭으로 '강설량 측정' / '장비 지원' 전환
app.js                  화면 로직 (지도, 표, 탭 전환, 업로드 병합 등)
data/roads.json         고속도로 노선 좌표 (거의 변경 없음)
data/hierarchy.json     본부/지사/관측소 배정 정보 (거의 변경 없음)
data/snow_data.json     시즌별 일 신적설 데이터

jurisdiction/           '기관별 관할 고속도로' 탭 (구간을 눌러 지사 이동, 신설 기관, 본부 이동)
  core.js                 변경 적용·관측소 배정·적설 재계산 (화면 없이 계산만)
  ui.js / style.css       화면
grid/                   '예보 격자 편입' 탭 (기상청 5km 격자를 지도에서 골라 기관에 편입, 여러 기관 공유 가능)
  core.js                 격자 변환·편입 계산·호출량 판정 / ui.js·style.css 화면
data/grid_assign.json   격자 기본 편입(칸별 기관)과 후보 칸
data/grid_changes.json  (비상용) 서버에 연결하지 못할 때 대신 읽는 격자 변경 이력 — 실제 이력은 서버(Supabase)에 저장
tools/build_grid_assign.py  격자 기본 편입 생성 도구
data/sections.json      관할 구간(IC/JC 사이) 모양과 기본 소속
data/jurisdiction_changes.json  (비상용) 서버에 연결하지 못할 때 대신 읽는 관할 변경 이력 — 실제 이력은 서버(Supabase)에 저장
data/stations.json      관측소 좌표 목록 (지금은 배정된 적 있는 관측소만)
tools/build_jurisdiction.py  구간 생성 도구 (표준노드링크에서 걸러낸 파일 필요)
tools/add_unassigned_sections.py  미지정 고속도로(어느 지사에도 속하지 않은 도로) 구간 추가 도구
docs/unassigned-sections-report.md  미지정 구간 생성 결과

equipment/              장비 지원 페이지 (index.html 의 '장비 지원' 탭에 표시됨)
  index.html              화면 틀
  css/style.css           디자인 (색, 글자, 배치)
  js/sample-data.js       샘플 데이터 (가상 차량번호·가짜 운전원. 실제 데이터 아님)
  js/api.js               서버와 주고받는 곳 (지금은 서버 없음. 서버 연결 시 이 파일만 바꿈)
  js/app.js               화면과 동작 (역할·권한, 저장, 수정기록, 탭, 이벤트)

docs/jurisdiction-rules.md  관할 고속도로 변경 탭 동작 규칙
docs/grid-assign-rules.md  예보 격자 편입 탭 동작 규칙
docs/d1-schema-design.md   Cloudflare D1 표 설계 v1(설계안), docs/d1-schema-v1.sql
docs/supabase-design.md      Supabase 구성(snow-support, 서울): 표·권한·기록·시험·남은 일
supabase/migrations/       Supabase 표·권한(RLS)·기록 트리거 SQL (실제 적용한 것)
supabase/tests/rls_test.sql  권한·기록 자동 시험(SQL Editor 에서 실행, 103항목)
supabase/tests/events_test.sql  변경 이력 표 권한·종류·원자성 시험(24항목)
supabase/tests/requests_test.sql  구간 변경 요청 표 권한·제한 시험
supabase/tests/accounts_check.sql  실제 계정 점검(낯선 가입자·임시 비밀번호 계정·관리자)
supabase/seed/            본부·지사 기준정보 SQL
supabase/functions/import-reference/  GitHub 의 data/*.json 을 서버에서 읽어 DB 로 옮기는 함수(기준정보 이전)
tools/run_all_tests.py     모든 자동 시험을 한 번에 실행하고 결과 표를 보여 줌(--fast 는 화면 시험 제외)
tools/reference_check.py   DB 와 data/*.json 이 같은지 확인하는 검증 SQL 생성
tools/fill_section_gaps.py  구간 사이 끊김을 실제 도로망으로 메우는 도구(결과 docs/section-gaps-report.md)
supabase/functions/account-admin/  계정 발급·초기화·비활성화·비밀번호 일괄 설정 함수(Edge Function)
admin/                  관리 콘솔(로그인, 비밀번호 변경, 계정 관리, 비밀번호 일괄 설정 엑셀표, 접속 로그) — docs/admin-console.md
auth/                   로그인 공통 부품(auth.js)·변경 이력 저장/읽기 부품(events.js)·첫 화면 로그인 잠금(gate.js·gate.css) — docs/login-gate.md
docs/accounts.md           계정 목록(아이디만, 비밀번호 없음)
CLAUDE.md                  Claude Code 가 매번 가장 먼저 읽는 안내판(규칙·구조·하지 말 것)
docs/claude-code-setup.md  내 컴퓨터에서 Claude Code(데스크톱 앱) 시작하기, 채팅과 이어 가는 법, 마무리 체크리스트
docs/handoff.md            채팅의 Claude 와 Claude Code 가 서로 알 수 있는 유일한 통로(인계 메모)
docs/admin-console.md       관리 콘솔 사용 안내
docs/login-gate.md          로그인 잠금·자동 로그인·아이디 저장·용어(캐시·쿠키·브라우저 저장소) 설명
tests/test_account_admin.mjs  계정 발급 함수 자동 시험(17항목)
tests/test_admin_policy_parity.mjs  화면·서버 비밀번호 규칙 일치 시험
tests/test_admin_ui.py      관리 콘솔 화면 자동 시험(가짜 서버, 19항목)
tests/test_jurisdiction_requests.py  구간 변경 요청·관리자 알림·격자 탭 관리자 전용 시험(10항목)
tests/test_import_reference.mjs  기준정보 이전 함수 자동 시험(12항목, 실제 data/*.json 사용)
tests/test_login_gate.py    첫 화면 로그인 잠금·자동 로그인·아이디 저장 자동 시험(13항목)
tests/test_hierarchy_order.py  본부·지사 순서가 강설량 측정 화면과 같은지 실제 자료로 확인(6항목)
tests/_sb_mock.py          가짜 Supabase 서버(화면 시험용)
docs/jurisdiction-build-report.md  구간 생성·끝점 보정 결과 보고서
docs/equipment-rules.md   장비 지원 페이지 동작 규칙 (사람이 읽는 문서: 권한 표, 저장·로그·개인정보 규칙)
docs/decisions.md         결정 사항과 배경 (서버 이전 계획, 개인정보 메모 등. 작업 이어가기용)
tests/test_equipment.py   장비 지원 페이지 자동 테스트
tests/test_grid_core.js  격자 계산 자동 테스트 (node tests/test_grid_core.js)
tests/test_grid_ui.py    격자 편입 탭 화면 자동 테스트
tests/test_jurisdiction_core.js  관할 변경 계산 자동 테스트 (node tests/test_jurisdiction_core.js)
tests/test_sections_continuity.py  구간 데이터가 끊김 없이 이어지는지·지사 구간이 그대로인지 확인(5항목)
tests/test_reapply.js       저장 후 새로고침 없이 다시 적용하는 계산이 처음부터 적용한 결과와 같은지 확인(실제 자료, 7항목)
tests/test_jurisdiction_ui.py    관할 변경 탭 화면 자동 테스트
```

## 장비 지원 페이지 확인 방법

- **그냥 열어보기**: `equipment/index.html` 을 더블클릭하면 브라우저에서 열립니다. (상단 "접속 아이디(데모)"로 역할을 바꿔 볼 수 있습니다)
- **자동 테스트** (수정 후 "전과 똑같이 동작하는지" 확인):
  ```
  pip install playwright
  playwright install chromium
  python tests/test_equipment.py
  ```
  `15/15 통과` 처럼 나오면 정상입니다. 하나라도 `FAIL` 이면 어디가 틀렸는지 함께 표시됩니다.
- 현재는 샘플 데이터이며 **저장해도 새로고침하면 사라집니다.** (서버 미연결)

## 데이터 갱신 방식 — 수동(크롬 콘솔)

기상청 API를 자동으로 호출하는 서버/워크플로는 두지 않습니다 (보안·IP 차단 문제로 제거함). 대신:

1. `https://apihub.kma.go.kr` 접속 후 콘솔에서 데이터 수집 스크립트 실행 → txt 파일 다운로드
2. 사이트의 **"연도별 신적설"** 탭 → **"+ 신적설 데이터 파일 추가"** 로 그 txt 파일 업로드
   - 하루치만 있는 파일이든, 특정 기간만 있는 파일이든 상관없이 업로드하면 날짜를 보고 알맞은 시즌(11.15~익년3.15)에 자동으로 들어갑니다
   - 이미 해당 시즌 전체 데이터가 채워져 있는 상태에서 겹치는 날짜를 올리면, 덮어쓸지 다시 물어봅니다
3. (선택) **"⬇ 갱신된 데이터 JSON 저장"** 버튼으로 현재 브라우저에 반영된 전체 데이터를 내려받아, 레포에 `data/snow_data.json`으로 커밋하면 다른 방문자에게도 영구 반영됩니다 (업로드만으로는 내 브라우저 세션에만 반영되고, 새로고침하면 사라집니다)

## 신적설 계산 방식

하루 00시~23시, 1시간 간격으로 그 시각까지의 누적 적설(`sd=day`)을 조회한 뒤, 관측소별로 **그날의 최댓값**을 그 날짜의 신적설로 사용합니다.

## 관측소 배정 기준

각 지사 관할구간 기준 반경 **5km**를 기본으로 하되, 5km 이내 관측소가 5대 이하이면 6km→7km→8km까지 단계적으로 확대합니다. 한 관측소가 여러 지사와 가까우면 중복으로 포함될 수 있습니다.
