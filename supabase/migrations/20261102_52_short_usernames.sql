-- ============================================================
-- 52. 아이디를 짧게 바꿈 (2026-11-02 사용자 결정, Claude 채팅)
--  · 본부 = ex + 본부 글자(a 수도권 · b 서울경기 · c 강원 · d 충북 · e 대전충남 · f 전북 · g 광주전남 · h 대구경북 · i 부산경남) + 00
--  · 지사 = ex + 본부 글자 + 강설량 측정 화면의 지사 순서 두 자리(01~). 예) 충주 = exd03, 합천 = exi11
--  · 기계화부(지원장비) = exm01 서울경기 · exm02 충북 · exm03 전북 · exm04 대구경북 (사용자 결정: g 는 광주전남과 겹쳐 m)
--  · 관리자 admin-01·admin-02 는 그대로. 비밀번호·권한·소속은 그대로(아이디만 바뀜).
--  · 로그인 아이디 = profiles.username, 로그인 이메일 = <아이디>@snow-support.invalid (auth.users.email + auth.identities.identity_data)
--    세 곳을 한 번에 바꿈. 하나라도 어긋나면(없는 옛 아이디, 이미 있는 새 아이디, 개수 다름) 전부 취소.
--  · 옛 아이디 → 새 아이디 표: docs/accounts.md
-- ============================================================
do $m$
declare n int; e int;
begin
  create temp table _ren (old text primary key, new text unique not null) on commit drop;
  insert into _ren values
    ('exsudogwon','exa00'),
    ('exincheon','exa01'),
    ('exsiheung','exa02'),
    ('exgunpo','exa03'),
    ('exhwaseong','exa04'),
    ('expaju','exa05'),
    ('exseoulgyeonggi','exb00'),
    ('exdongseoul','exb01'),
    ('exgyeonggigwangju','exb02'),
    ('exsuwon','exb03'),
    ('exicheon','exb04'),
    ('exyongin','exb05'),
    ('exgangwon','exc00'),
    ('exwonju','exc01'),
    ('exdaegwallyeong','exc02'),
    ('exhongcheon','exc03'),
    ('exchuncheon','exc04'),
    ('exgangneung','exc05'),
    ('exyangyang','exc06'),
    ('exchungbuk','exd00'),
    ('exjincheon','exd01'),
    ('exjecheon','exd02'),
    ('exchungju','exd03'),
    ('exboeun','exd04'),
    ('exeomjeong','exd05'),
    ('exsangju','exd06'),
    ('exdaejeonchungnam','exe00'),
    ('excheonan','exe01'),
    ('exdaejeon','exe02'),
    ('exyeongdong','exe03'),
    ('exdangjin','exe04'),
    ('exgongju','exe05'),
    ('exbuyeo','exe06'),
    ('exjeonbuk','exf00'),
    ('exjeonju','exf01'),
    ('exbuan','exf02'),
    ('exmuju','exf03'),
    ('exnonsan','exf04'),
    ('exjinan','exf05'),
    ('exboryeong','exf06'),
    ('exnamwon','exf07'),
    ('exgwangjujeonnam','exg00'),
    ('exgwangju','exg01'),
    ('exdamyang','exg02'),
    ('exsuncheon','exg03'),
    ('exhampyeong','exg04'),
    ('exgurye','exg05'),
    ('exboseong','exg06'),
    ('exyeongam','exg07'),
    ('exdaegugyeongbuk','exh00'),
    ('exgumi','exh01'),
    ('exdaegu','exh02'),
    ('exgunwi','exh03'),
    ('exyeongcheon','exh04'),
    ('exgoryeong','exh05'),
    ('exyeongju','exh06'),
    ('exseongju','exh07'),
    ('excheongsong','exh08'),
    ('exbusangyeongnam','exi00'),
    ('exulsan','exi01'),
    ('exyangsan','exi02'),
    ('exchangwon','exi03'),
    ('exjinju','exi04'),
    ('exsancheong','exi05'),
    ('exgyeongju','exi06'),
    ('exchangnyeong','exi07'),
    ('exgoseong','exi08'),
    ('exseoulsan','exi09'),
    ('exmiryang','exi10'),
    ('exhapcheon','exi11'),
    ('exseoulgigyae','exm01'),
    ('exchungbukgigyae','exm02'),
    ('exjeonbukgigyae','exm03'),
    ('exdaegugigyae','exm04');
  if (select count(*) from _ren) <> 74 then raise exception 'mapping size'; end if;
  if exists (select 1 from _ren r where not exists (select 1 from public.profiles p where p.username = r.old)) then
    raise exception 'old username missing: %', (select string_agg(old, ',') from _ren r where not exists (select 1 from public.profiles p where p.username = r.old));
  end if;
  if exists (select 1 from public.profiles p join _ren r on p.username = r.new) then raise exception 'new username already taken'; end if;
  if exists (select 1 from auth.users u join _ren r on u.email = r.new || '@snow-support.invalid') then raise exception 'new email already taken'; end if;

  update auth.users u set email = r.new || '@snow-support.invalid', updated_at = now()
    from public.profiles p join _ren r on r.old = p.username
   where u.id = p.id and u.email = r.old || '@snow-support.invalid';
  get diagnostics e = row_count;
  update auth.identities i set identity_data = jsonb_set(i.identity_data, '{email}', to_jsonb(r.new || '@snow-support.invalid')), updated_at = now()
    from public.profiles p join _ren r on r.old = p.username
   where i.user_id = p.id and i.provider = 'email';
  update public.profiles p set username = r.new from _ren r where p.username = r.old;
  get diagnostics n = row_count;
  if n <> 74 or e <> 74 then raise exception 'renamed profiles %, emails % (need 74 each)', n, e; end if;
  if exists (select 1 from public.profiles p join auth.users u on u.id = p.id where u.email <> p.username || '@snow-support.invalid') then
    raise exception 'username/email mismatch after rename';
  end if;
end $m$;
