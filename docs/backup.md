# 백업 · 저장소 비공개 전환 안내

## 1. ⚠ 먼저 알아 둘 것: 비공개로 바꾸면 사이트가 꺼질 수 있습니다
- **GitHub 무료 계정에서는 비공개 저장소로 GitHub Pages(지금 사이트 주소)를 쓸 수 없습니다.** 비공개로 바꾸는 순간 `https://iplaypiccolo.github.io/Snow-Amount-Measurement/` 가 열리지 않게 됩니다.
- 비공개 저장소에서도 사이트를 계속 쓰려면 둘 중 하나가 필요합니다.
  1. **GitHub Pro**(개인 유료, 월 약 4달러) — 설정만 바꾸면 지금 주소 그대로 동작. 가장 간단합니다.
  2. 사이트만 다른 곳(예: Cloudflare Pages 무료)에서 열기 — 주소가 바뀌고 설정 작업이 필요합니다.
- 참고: GitHub Pro 로 비공개 저장소의 Pages 를 써도 **사이트 자체는 인터넷에 공개**됩니다(로그인 잠금은 그대로). 비공개가 되는 것은 "저장소(코드·파일 목록)"입니다.
- 적설 자료는 이제 서버(Supabase)에서 로그인한 사람만 읽습니다. 다만 `data/snow_data.json` 등 예전 파일은 저장소와 사이트 주소에 아직 남아 있습니다(시험과 처음 옮기기에 씀).

## 2. 비공개로 바꾸는 방법 (사용자가 직접)
1. GitHub 에서 저장소 열기 → 위쪽 **Settings**
2. 맨 아래 **Danger Zone** → **Change repository visibility** → **Change visibility** → **Make private**
3. 저장소 이름을 입력해 확인
- **비공개로 바꾸기 전에 할 일**: 관리 콘솔 → **적설 자료** → "예전 파일에서 처음 옮기기" [옮기기]를 먼저 해 두세요. 이 기능은 서버가 GitHub 공개 파일을 직접 읽기 때문에, 비공개가 되면 동작하지 않습니다(이후 새 자료는 메모장 파일 올리기로 넣으므로 상관없음).
- 같은 이유로 기준정보 이전 함수(`import-reference`)도 비공개 뒤에는 쓸 수 없습니다(지금은 이미 옮겨 둠).

## 3. 자동 백업 켜기 (작업 파일 옮기기 + 비밀값 2개를 직접 넣기)
0. **작업 파일을 제자리에 두기(한 번만)**: 작업 파일은 지금 `tools/github-actions/supabase-backup.yml` 에 있습니다(Claude 가 쓰는 토큰에는 GitHub Actions 파일을 올리는 권한이 없어서). GitHub 웹에서 저장소 → **Add file → Create new file** → 이름 칸에 `.github/workflows/supabase-backup.yml` 입력 → 위 파일 내용을 그대로 붙여넣기 → **Commit changes**. (또는 Claude 에게 workflow 권한이 있는 토큰을 주고 옮겨 달라고 하기)
그러면 `.github/workflows/supabase-backup.yml` 이 **월·목 새벽 3시에 서버를 깨우고**(1주 미사용 자동 정지 방지), **월요일에는 DB 전체를 암호화해서** 이 저장소의 `backups` 브랜치에 최근 8개를 보관합니다. **공개 저장소일 때는 백업을 건너뛰고 깨우기만** 합니다.

1. Supabase 대시보드 → 프로젝트 `snow-support` → 위쪽 **Connect** → **Session pooler** 의 주소를 복사(`postgresql://postgres.yzwbnohzhnctdvufntig:[비밀번호]@aws-…pooler.supabase.com:5432/postgres`). `[YOUR-PASSWORD]` 부분은 DB 비밀번호로 바꿉니다(모르면 Database 설정에서 재설정).
   - "Direct connection" 주소는 GitHub 에서 접속되지 않으니(IPv6 전용) **Session pooler** 를 쓰세요.
2. GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret**
   - 이름 `SUPABASE_DB_URL`, 값 = 위 주소
   - 이름 `BACKUP_PASSPHRASE`, 값 = 아무 긴 문장(예: 20자 이상). **잃어버리면 백업을 열 수 없으니 따로 안전하게 보관**하세요.
3. 확인: 저장소 → **Actions → Supabase 백업·깨우기 → Run workflow**. 초록색이면 성공, `backups` 브랜치에 `snow-support_날짜.sql.gz.gpg` 가 생깁니다.
- 비밀값은 대화·파일·커밋에 쓰지 마세요(CLAUDE.md 규칙). GitHub 화면에만 넣습니다.
- 백업에는 계정 정보(auth, 비밀번호는 해시 형태)가 들어 있어 **암호화한 뒤 비공개 저장소에만** 보관합니다.

## 4. 복원 (필요할 때만, 되돌리기 어려우니 먼저 상의)
```
gpg --decrypt snow-support_2026-10-05_0300.sql.gz.gpg > db.sql.gz      # BACKUP_PASSPHRASE 입력
gunzip db.sql.gz
psql "<Session pooler 주소>" -f db.sql                                 # 새(빈) 프로젝트에 넣는 것을 권장
```
- 운영 DB 에 바로 덮어쓰지 말고, 새 Supabase 프로젝트에 넣어 확인한 뒤 옮기는 것을 권합니다.
