# 계정 목록 (아이디만 — 비밀번호는 이 저장소에 없습니다)

Supabase `snow-support` 의 계정입니다. 로그인용 이메일은 아이디에서 자동으로 만든 **가짜 주소** `<아이디>@snow-support.invalid` 이고 메일은 보내지 않습니다.
- **2026-11-02 아이디를 짧게 바꿈**(사용자 결정, 마이그레이션 52). 비밀번호·권한·소속은 그대로이고 아이디만 바뀌었습니다. 아래 표의 '예전 아이디'로는 더 이상 로그인할 수 없습니다.
- 규칙: **본부** = `ex` + 본부 글자 + `00` / **지사** = `ex` + 본부 글자 + 지사 순서 두 자리(강설량 측정 화면 순서) / **기계화부(지원장비)** = `exm` + 두 자리.
  본부 글자: a 수도권 · b 서울경기 · c 강원 · d 충북 · e 대전충남 · f 전북 · g 광주전남 · h 대구경북 · i 부산경남. 기계화부는 g 가 광주전남과 겹쳐 **m**.
- 지사를 새로 만들면 그 본부의 다음 번호를 씁니다(예: 부산경남에 하나 더 → `exi12`). 지사 순서를 나중에 바꿔도 **이미 정한 아이디는 바꾸지 않습니다**(바꾸면 담당자가 헷갈림).
- 비밀번호 규칙(2026-11-02 간단하게): **8자 이상, 영문·숫자 각 1개 이상**(공백 안 됨, Supabase 설정과 같음). 관리 콘솔 [비밀번호 일괄 설정]에서 정합니다.

## 관리자 (2) — 그대로

| 아이디 | 이름 | 비고 |
|---|---|---|
| `admin-01` | 관리자1 | 직접 만든 계정(비밀번호는 본인만 앎) |
| `admin-02` | 관리자2 | |

## 본부·지사 (본부 9 + 지사 61)

| 본부 | 이름 | 아이디 | 예전 아이디 |
|---|---|---|---|
| 수도권 | 수도권본부 | `exa00` | exsudogwon |
| 수도권 | 인천지사 | `exa01` | exincheon |
| 수도권 | 시흥지사 | `exa02` | exsiheung |
| 수도권 | 군포지사 | `exa03` | exgunpo |
| 수도권 | 화성지사 | `exa04` | exhwaseong |
| 수도권 | 파주지사 | `exa05` | expaju |
| 서울경기 | 서울경기본부 | `exb00` | exseoulgyeonggi |
| 서울경기 | 동서울지사 | `exb01` | exdongseoul |
| 서울경기 | 경기광주지사 | `exb02` | exgyeonggigwangju |
| 서울경기 | 수원지사 | `exb03` | exsuwon |
| 서울경기 | 이천지사 | `exb04` | exicheon |
| 서울경기 | 용인지사 | `exb05` | exyongin |
| 강원 | 강원본부 | `exc00` | exgangwon |
| 강원 | 원주지사 | `exc01` | exwonju |
| 강원 | 대관령지사 | `exc02` | exdaegwallyeong |
| 강원 | 홍천지사 | `exc03` | exhongcheon |
| 강원 | 춘천지사 | `exc04` | exchuncheon |
| 강원 | 강릉지사 | `exc05` | exgangneung |
| 강원 | 양양지사 | `exc06` | exyangyang |
| 충북 | 충북본부 | `exd00` | exchungbuk |
| 충북 | 진천지사 | `exd01` | exjincheon |
| 충북 | 제천지사 | `exd02` | exjecheon |
| 충북 | 충주지사 | `exd03` | exchungju |
| 충북 | 보은지사 | `exd04` | exboeun |
| 충북 | 엄정지사 | `exd05` | exeomjeong |
| 충북 | 상주지사 | `exd06` | exsangju |
| 대전충남 | 대전충남본부 | `exe00` | exdaejeonchungnam |
| 대전충남 | 천안지사 | `exe01` | excheonan |
| 대전충남 | 대전지사 | `exe02` | exdaejeon |
| 대전충남 | 영동지사 | `exe03` | exyeongdong |
| 대전충남 | 당진지사 | `exe04` | exdangjin |
| 대전충남 | 공주지사 | `exe05` | exgongju |
| 대전충남 | 부여지사 | `exe06` | exbuyeo |
| 전북 | 전북본부 | `exf00` | exjeonbuk |
| 전북 | 전주지사 | `exf01` | exjeonju |
| 전북 | 부안지사 | `exf02` | exbuan |
| 전북 | 무주지사 | `exf03` | exmuju |
| 전북 | 논산지사 | `exf04` | exnonsan |
| 전북 | 진안지사 | `exf05` | exjinan |
| 전북 | 보령지사 | `exf06` | exboryeong |
| 전북 | 남원지사 | `exf07` | exnamwon |
| 광주전남 | 광주전남본부 | `exg00` | exgwangjujeonnam |
| 광주전남 | 광주지사 | `exg01` | exgwangju |
| 광주전남 | 담양지사 | `exg02` | exdamyang |
| 광주전남 | 순천지사 | `exg03` | exsuncheon |
| 광주전남 | 함평지사 | `exg04` | exhampyeong |
| 광주전남 | 구례지사 | `exg05` | exgurye |
| 광주전남 | 보성지사 | `exg06` | exboseong |
| 광주전남 | 영암지사 | `exg07` | exyeongam |
| 대구경북 | 대구경북본부 | `exh00` | exdaegugyeongbuk |
| 대구경북 | 구미지사 | `exh01` | exgumi |
| 대구경북 | 대구지사 | `exh02` | exdaegu |
| 대구경북 | 군위지사 | `exh03` | exgunwi |
| 대구경북 | 영천지사 | `exh04` | exyeongcheon |
| 대구경북 | 고령지사 | `exh05` | exgoryeong |
| 대구경북 | 영주지사 | `exh06` | exyeongju |
| 대구경북 | 성주지사 | `exh07` | exseongju |
| 대구경북 | 청송지사 | `exh08` | excheongsong |
| 부산경남 | 부산경남본부 | `exi00` | exbusangyeongnam |
| 부산경남 | 울산지사 | `exi01` | exulsan |
| 부산경남 | 양산지사 | `exi02` | exyangsan |
| 부산경남 | 창원지사 | `exi03` | exchangwon |
| 부산경남 | 진주지사 | `exi04` | exjinju |
| 부산경남 | 산청지사 | `exi05` | exsancheong |
| 부산경남 | 경주지사 | `exi06` | exgyeongju |
| 부산경남 | 창녕지사 | `exi07` | exchangnyeong |
| 부산경남 | 고성지사 | `exi08` | exgoseong |
| 부산경남 | 서울산지사 | `exi09` | exseoulsan |
| 부산경남 | 밀양지사 | `exi10` | exmiryang |
| 부산경남 | 합천지사 | `exi11` | exhapcheon |

## 기계화부(지원장비) (4)

| 아이디 | 이름 | 예전 아이디 |
|---|---|---|
| `exm01` | 서울경기 기계화부 | exseoulgigyae |
| `exm02` | 충북 기계화부 | exchungbukgigyae |
| `exm03` | 전북 기계화부 | exjeonbukgigyae |
| `exm04` | 대구경북 기계화부 | exdaegugigyae |
