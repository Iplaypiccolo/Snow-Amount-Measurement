# Cloudflare 배포 안내

로그인(아이디·비밀번호)·접속 로그·기상청 자료 수집을 위한 서버 부분입니다.
**공개되면 안 되는 데이터(계정, 비밀번호 해시, 접속 기록)는 Cloudflare D1 데이터베이스에만** 저장하고, 화면(HTML)은 `pages.dev` 로 보여줍니다.

```
사용자 브라우저 ── https://<프로젝트>.pages.dev ──► [Pages: 화면 + /api 서버 코드] ──► [D1 데이터베이스]
                                                                                    ▲
        [수집 Worker: 30분마다 기상청 API 호출, 결과 기록] ───────────────────────────┘
```

| 폴더/파일 | 역할 |
|---|---|
| `functions/api/…` | 서버 코드(로그인, 로그아웃, 비밀번호 변경, 계정 관리, 접속 로그, 수집 상태) |
| `functions/_lib/…` | 공통 부분(비밀번호 해시, 로그인 상태, 시도 제한, 기록) |
| `admin/` | 관리자 콘솔 화면 (`/admin/`) |
| `cloudflare/schema.sql` | D1 표 정의 |
| `workers/collector/` | 기상청 API를 정해진 시각에 호출하는 수집 Worker (지금은 **접속 시험판**) |
| `wrangler.jsonc` | Pages 설정 / `workers/collector/wrangler.jsonc`: 수집 Worker 설정 |

> ⚠ 이 코드는 **컴퓨터 안의 흉내와 로컬 Workers 실행 환경(workerd)으로만 시험**했고, 실제 Cloudflare 계정에는 아직 올려 보지 않았습니다. 아래 "확인 체크리스트"를 따라 처음 배포 후 직접 확인해 주세요.

## 준비물
- Cloudflare 계정 (무료로 시작 가능, 아래 "비용·한도" 참고)
- Node.js(LTS) 설치 → 명령 프롬프트(터미널)에서 이 저장소 폴더로 이동
- (기상청 수집용) 기상청 인증키

## 처음 한 번 하는 순서
1. **로그인**: `npx wrangler login` (브라우저가 열리면 허용)
2. **데이터베이스 만들기**: `npx wrangler d1 create snow-ops`
   - 출력되는 `database_id` 값을 복사해서 **`wrangler.jsonc`** 와 **`workers/collector/wrangler.jsonc`** 두 파일의 `REPLACE_WITH_DATABASE_ID` 를 바꾸세요.
3. **표 만들기**: `npx wrangler d1 execute snow-ops --remote --file=cloudflare/schema.sql`
   - (선택) 접속 기록을 DB 차원에서도 못 고치게: `npx wrangler d1 execute snow-ops --remote --file=cloudflare/schema_append_only.sql`
4. **첫 관리자용 설정 코드 넣기**: `npx wrangler pages secret put SETUP_TOKEN --project-name snow-ops`
   - 길고 무작위인 문자열을 입력합니다. (프로젝트가 아직 없으면 먼저 5번을 하고 돌아오세요)
5. **화면 + 서버 배포**: `npx wrangler pages deploy . --project-name snow-ops`
   - 비밀값(4번)을 넣은 뒤에는 한 번 더 배포해야 적용됩니다. 주소는 `https://snow-ops.pages.dev` 형태입니다(이름이 이미 쓰이면 다른 이름을 고르세요).
6. **첫 관리자 만들기**: 브라우저에서 `https://<프로젝트>.pages.dev/admin/` 접속 → "첫 관리자 만들기"에 설정 코드, 아이디, 비밀번호 입력
   - 끝나면 설정 코드를 지우세요: `npx wrangler pages secret delete SETUP_TOKEN --project-name snow-ops` (그 뒤 한 번 더 배포)
7. **계정 만들기**: 관리자 콘솔 → 계정 관리 → 사람마다 개인 아이디를 만들고, 표시되는 임시 비밀번호를 안전하게 전달합니다. (첫 로그인 때 바꾸게 됩니다)
8. **기상청 수집 시험판 올리기**
   - `workers/collector/wrangler.jsonc` 의 `KMA_PROBE_URL` 을 본인이 쓰는 기상청 API 주소로 바꿉니다. (인증키 자리는 `{KEY}` 로 둡니다)
   - `cd workers/collector` → `npx wrangler secret put KMA_KEY` (기상청 인증키 입력) → `npx wrangler deploy`
   - 30분 안에 관리자 콘솔의 **수집 상태** 탭에 기록이 쌓입니다. **성공(200)** 이면 Cloudflare 에서 기상청에 접속할 수 있다는 뜻입니다.

## 확인 체크리스트 (회사 PC에서)
| 확인 | 기대 결과 |
|---|---|
| `https://<프로젝트>.pages.dev/api/health` 열기 | `{"ok":true}` |
| `/admin/` 열기 | 로그인 화면(또는 첫 관리자 만들기) |
| 틀린 비밀번호로 5번 시도 | 잠깐 막힘 안내 |
| 관리자로 로그인 → 계정 만들기 | 임시 비밀번호 표시, 접속 로그에 기록 |
| 수집 상태 탭 | 자동 실행 기록 (성공/실패와 원인) |
| 로그인 중 오류 `1102` / "CPU" 문구 | 아래 "비용·한도"의 CPU 항목 참고 |

## 보안 설계 (만든 것)
- 비밀번호는 **해시(PBKDF2-SHA256 + 무작위 salt)** 로만 저장. 응답·기록 어디에도 원문이 나오지 않음.
- 로그인 상태는 무작위 토큰 → 쿠키(`__Host-`, HttpOnly, Secure, SameSite=Strict), DB에는 **토큰의 해시만** 저장. 로그인 후 최대 10시간, 2시간 동안 아무 동작이 없으면 자동 로그아웃.
- 같은 아이디로 15분 안에 5번 틀리면 잠금, 같은 IP에서 10분 안에 30번 틀리면 차단. 없는 아이디도 같은 시간·같은 문구로 응답.
- 비밀번호 변경·초기화·비활성화 시 해당 계정의 다른 로그인은 모두 끊김. 마지막 관리자와 본인 계정은 비활성화할 수 없음.
- 모든 "바꾸는 요청"은 같은 사이트(Origin)에서 온 것만 허용.
- 권한(관리자/피지원지사/지원장비)은 **서버가** 매 요청마다 검사. 접속·실패·권한 거부·계정 변경은 IP와 함께 기록(추가만 가능).
- 기상청 인증키는 Cloudflare 비밀값으로만 보관하고, 기록에는 `***` 로 가려서 남김.

## 비용·한도 (알아둘 점)
- **로그인 계산량(CPU)**: 비밀번호 확인은 의도적으로 무거운 계산입니다. Workers 가 허용하는 반복 횟수 상한은 **100,000회**(OWASP 권고 600,000회보다 낮음)이고, 무료 플랜의 요청당 CPU 한도는 10ms 라서 **로그인이 무료 한도를 넘어 오류(1102)가 날 수 있습니다.** 이 경우 Workers Paid(월 $5)로 전환하세요. (제 환경의 로컬 실행에서는 로그인 한 번이 약 0.07초(벽시계) 걸렸고 오류는 없었지만, 실제 Cloudflare 의 CPU 측정과는 다릅니다.)
- 반복 횟수가 낮은 대신 **임시 비밀번호는 16자 무작위**, 직접 정하는 비밀번호는 **12자 이상**, **5회 실패 잠금**으로 보완했습니다. 보안팀 검토를 받으세요.
- 수집 Worker 무료 한도: 실행당 외부 요청 50개, 크론 실행당 CPU 10ms, 크론은 계정당 5개. 지점이 많으면 한 번에 여러 지점이 오는 API를 쓰거나 유료로 전환해야 합니다.
- D1 무료: 하루 읽기 500만 행 / 쓰기 10만 행 / 저장 5GB.

## 아직 안 한 것 (다음 단계)
1. 기상청 응답 형식 확인 후 **실제 자료 파싱·저장**(적설·특보)
2. 강설량·관할·장비 지원 페이지를 **로그인 + D1 데이터**로 연결
3. 로그인 화면(`admin/`)을 사이트 전체의 로그인으로 통합, 2단계 인증·CSP 등 추가 보안
4. 보안팀 확인: pages.dev 사용 및 개인정보(국외 이전) 동의 문구 반영
