# 서버 깨우기 · 저장소 비공개 전환

## 1. 서버 깨우기 (자동, 설정할 것 없음)
- Supabase 무료 플랜은 **1주일 동안 쓰지 않으면 자동 정지**됩니다(눈이 없는 여름에 위험).
- `.github/workflows/supabase-keepalive.yml` 이 **월·목 새벽 3시(한국 시각)** 에 서버의 `keepalive` 함수(현재 시각만 돌려줌)를 부릅니다.
- **비밀값이 필요 없습니다.** 화면 코드에도 들어 있는 공개 키만 씁니다. `keepalive` 는 어떤 표도 읽거나 쓰지 않습니다(`supabase/migrations/20261004_13_keepalive.sql`).
- 백업 파일은 받지 않습니다(사용자 결정 2026-10-04: 깨우기가 목적). 무료 플랜은 자동 백업이 없으므로, 큰 변경 전에는 필요한 표를 따로 내려받아 두세요(CLAUDE.md 규칙 4).
- 확인: 저장소 → **Actions → Supabase 깨우기** 에 초록색 기록이 쌓이면 정상. **Run workflow** 로 바로 실행해 볼 수도 있습니다.
- 빨간색(실패)이면 서버가 이미 정지됐을 수 있습니다 → Supabase 대시보드에서 프로젝트 **Restore**.
- 참고: GitHub 는 **공개 저장소**에서 60일 동안 활동(커밋)이 없으면 예약 작업을 멈춥니다. 비공개 저장소는 해당 없음.

## 2. ⚠ 저장소를 비공개로 바꾸기 전에: 사이트 주소 문제
- **GitHub 무료 계정은 비공개 저장소로 GitHub Pages 를 쓸 수 없습니다.** 비공개로 바꾸는 순간 `https://iplaypiccolo.github.io/Snow-Amount-Measurement/` 가 열리지 않습니다.
- 무료로 계속 쓰려면 사이트를 **Cloudflare Pages(무료)** 로 옮기는 것을 권합니다. 비공개 GitHub 저장소를 연결하면 `main` 에 올릴 때마다 자동으로 다시 배포됩니다. 주소는 `https://<이름>.pages.dev` 로 바뀝니다.
  1. Cloudflare 계정 만들기(사용자가 직접) → **Workers & Pages → Create → Pages → Connect to Git** → GitHub 로그인 후 이 저장소만 허용
  2. 빌드 설정: Framework **None**, Build command **비움**, Output directory **/**(저장소 맨 위)
  3. 배포가 끝나면 나온 `*.pages.dev` 주소로 로그인 화면이 뜨는지 확인 → **회사 PC 에서도 열리는지 확인**(decisions.md 에 workers.dev 는 회사에서 막힌다는 기록이 있음. pages.dev 는 별도 확인 필요)
  4. 잘 열리면 그때 GitHub 저장소를 비공개로 전환(아래 3) → GitHub Pages 는 자동으로 꺼짐
- 화면 코드는 주소가 바뀌어도 그대로 동작합니다(서버 주소·보안 정책은 사이트 주소와 무관). 관리 콘솔 주소는 `<새 주소>/admin/`.

## 3. 비공개로 바꾸는 방법 (사용자가 직접)
1. GitHub 에서 저장소 열기 → 위쪽 **Settings**
2. 맨 아래 **Danger Zone** → **Change repository visibility** → **Change visibility** → **Make private** → 저장소 이름 입력해 확인
- 비공개 뒤에는 서버 함수 `import-reference`(기준정보를 GitHub 공개 파일에서 읽는 함수)가 동작하지 않습니다. 기준정보는 이미 옮겨 두었고, 적설은 관리 콘솔에서 메모장 파일로 올리므로 영향 없음.
- Claude(채팅·Code)가 저장소를 읽고 쓰려면 비공개 저장소에 접근 권한이 있는 토큰이 필요합니다(지금 쓰는 fine-grained 토큰은 이 저장소 권한이 있으면 그대로 됨).
