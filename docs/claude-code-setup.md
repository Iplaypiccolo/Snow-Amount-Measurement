# 내 컴퓨터에서 Claude Code(데스크톱 앱) 시작하기

이 문서는 **사용자 본인 컴퓨터**에서 Claude 데스크톱 앱의 Code 기능으로 이 프로젝트를 여는 순서입니다.
회사 컴퓨터에서는 지금처럼 claude.ai 채팅을 씁니다. **두 곳은 서로의 대화를 보지 못합니다** — 연결 고리는 이 저장소(GitHub)의 `CLAUDE.md`·`docs/handoff.md` 입니다.

## 역할 분담
| 어디서 | 무엇을 |
|---|---|
| **claude.ai 채팅**(회사·어디서나) | 새 기능 설계와 구현, 큰 변경, 설명 |
| **Claude Code**(내 컴퓨터) | 실제 서버·사이트 연결 확인, 버그 조사·수정, 시험 실행 |

## 1. 준비물 (처음 한 번)
1. **유료 Claude 플랜**: 공식 문서에 따르면 무료 플랜은 Claude Code 가 포함되지 않습니다(Pro, Max, Team, Enterprise 또는 Console 계정). 사용량은 채팅과 **같은 한도를 공유**합니다.
2. **Claude 데스크톱 앱** 설치 후 로그인 → 왼쪽의 **Code 탭**.
3. **Git** (Windows: Git for Windows). 데스크톱 앱이 새 세션마다 작업 사본(worktree)을 만들 때 Git 이 필요합니다.
4. **Node.js 22(LTS)**, **Python 3** — 시험을 돌리는 데 필요합니다.
5. 터미널(Windows PowerShell)에서 한 번: `pip install playwright` → `playwright install chromium`

## 2. 저장소 받기
데스크톱 앱의 폴더 선택은 **이미 내려받은 폴더만** 고를 수 있는 경우가 있으니 먼저 받아 둡니다.
```
git clone https://github.com/Iplaypiccolo/Snow-Amount-Measurement.git
```
(GitHub Desktop 으로 받아도 됩니다.) 이 저장소는 공개라서 받는 데 로그인이 필요 없지만, **올리는(push) 데는 GitHub 로그인이 필요**합니다 — `git push` 를 처음 할 때 나오는 로그인 창에서 로그인하세요. **토큰을 대화나 파일에 붙여 넣지 마세요.**

## 3. 첫 실행
1. Code 탭 → 새 세션 → 받은 폴더 선택.
2. 아래를 그대로 붙여 넣어 시작:
   > CLAUDE.md 와 docs/handoff.md 를 읽고, `python tools/run_all_tests.py --fast` 를 실행해서 현재 상태를 확인해 줘. 그다음 handoff.md 의 "Claude Code 의 첫 과제" 중 읽기만 하는 확인부터 하나씩 같이 해 보자. 쓰는 작업은 내가 허락하기 전에는 하지 마.
3. 권한 요청이 뜨면 **내용을 읽고 허용**하세요(기본값인 수동 승인을 유지하는 것을 권합니다. "모두 자동 허용"은 켜지 마세요).

## 4. Supabase 연결 (선택, 필요할 때)
Supabase 공식 안내 기준으로 연결 주소에 옵션을 붙일 수 있습니다.
- `project_ref=yzwbnohzhnctdvufntig` : **이 프로젝트 하나로만** 범위 제한(계정 전체 도구가 꺼짐)
- `read_only=true` : 읽기 전용 사용자로 실행
- `features=database,docs` : 쓸 도구 묶음만 켜기

**제안**: 두 개를 등록해 두고 평소에는 읽기 전용만 쓰세요.
```
claude mcp add --transport http supabase-ro "https://mcp.supabase.com/mcp?project_ref=yzwbnohzhnctdvufntig&read_only=true"
claude mcp add --transport http supabase-rw "https://mcp.supabase.com/mcp?project_ref=yzwbnohzhnctdvufntig"
```
(터미널을 안 쓰고 싶으면 Claude Code 세션에서 "이 주소로 MCP 를 추가해 줘"라고 요청해도 됩니다.) 처음 연결하면 브라우저가 열려 Supabase 에 로그인하고 **이 프로젝트가 있는 조직**을 선택합니다.
- Supabase 공식 문서는 "운영 DB 에는 연결하지 말라"고 권합니다. 이 프로젝트는 개발 중이지만 **실제 계정이 들어 있고 무료 플랜이라 별도 개발용 프로젝트를 둘 자리가 없습니다.** 그래서 ① 평소엔 읽기 전용 ② 쓰기는 필요할 때만 ③ **도구 호출 승인은 계속 수동** ④ 위험한 변경 전에는 자료 내려받기, 로 위험을 줄입니다.
- 사이트가 완성된 뒤 접근을 막을 때 아래 "마무리 체크리스트"를 따르세요.

## 5. 채팅과 이어 가기
- **Claude Code → 채팅**: 일을 마칠 때 `docs/handoff.md` 에 기록하고 푸시(CLAUDE.md 에 규칙으로 적혀 있음). 급하면 채팅에 "handoff.md 최신 항목 읽어 줘"라고 말하면 됩니다.
- **채팅 → Claude Code**: 채팅의 Claude 가 `main` 에 올린 것은 `git pull` 로 받습니다. 세션을 시작할 때 항상 pull 하라고 CLAUDE.md 에 적어 두었습니다.
- 채팅 쪽에서 새 대화를 시작할 때 첫 문장: *"저장소 Iplaypiccolo/Snow-Amount-Measurement 의 CLAUDE.md, docs/handoff.md, 최근 커밋 30개를 먼저 읽고 현재 상태를 요약해 줘."*
- 두 곳이 동시에 `main` 에 올리면 충돌할 수 있습니다. **한 번에 한 곳에서만 작업**하는 것을 권합니다.

## 6. 막힐 때 (공개된 알려진 문제)
- 새 세션이 "Git is required for local sessions" 로 막힘 → Git 설치 후 앱을 다시 시작, 앱 업데이트.
- 데스크톱 앱은 새 세션마다 별도 작업 사본(worktree)에서 일합니다. 그래서 **그 안에서 한 변경은 커밋 후 `main` 으로 올려야** 다른 곳에서 보입니다(CLAUDE.md 의 규칙 2).
- 시험이 "브라우저가 없다"고 하면 `playwright install chromium`.
- 세션이 열자마자 종료되면 앱을 최신으로 업데이트하고, 그래도 안 되면 터미널용 Claude Code 를 설치해 같은 폴더에서 `claude` 를 실행해 보세요(공식 설치: `irm https://claude.ai/install.ps1 | iex`).
- 어떤 문제든 **화면 캡처와 오류 문구**를 채팅에 붙여 주세요.

## 7. 사이트가 완성된 뒤: 마무리 체크리스트 (접근 닫기)
- [ ] Claude Code 의 Supabase MCP 연결 제거(`claude mcp remove supabase-rw`, `supabase-ro`) 
- [ ] Supabase 계정 설정에서 **승인해 준 앱/토큰이 남아 있으면 삭제** (메뉴 이름은 Supabase 화면에서 확인하세요 — 이 문서는 정확한 메뉴를 확인하지 못했습니다)
- [ ] GitHub: 쓰던 **개인 액세스 토큰 모두 폐기**(채팅에서 쓴 토큰 포함), 내 컴퓨터의 GitHub 로그인 정보 정리
- [ ] Supabase: `service_role` 키를 어디에도 저장하지 않았는지 확인, 필요하면 키 재발급
- [ ] 일회용 시작 토큰(`settings.bootstrap_token`)이 남아 있지 않은지, `pg_net` 확장이 꺼져 있는지 확인
- [ ] 자동 백업이 없는 무료 플랜이므로 **마지막 상태를 내려받아 보관**(변경 이력 백업 파일 + 필요한 표)
- [ ] 임시 비밀번호 CSV 파일(Storage `credentials`) 삭제
- [ ] 이후 변경은 다시 접근을 열기 전에 사용자 확인
