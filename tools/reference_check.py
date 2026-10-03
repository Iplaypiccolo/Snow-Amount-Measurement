#!/usr/bin/env python3
"""
기준정보 이전 검증 SQL 만들기 — data/*.json 의 "정답 지문(체크섬)"을 계산해서, DB 의 표가 파일과 한 칸도 다르지 않은지 확인하는 SQL 을 출력합니다.
사용:  python tools/reference_check.py > check.sql   →  Supabase SQL Editor 에 붙여넣어 실행  →  모든 열이 true 이면 DB 와 파일이 같습니다.
(파일이 바뀌면 지문도 바뀌므로 그때마다 다시 만드세요. 관할·격자 변경을 저장한 뒤에는 "기본(baseline)" 파일만 비교합니다.)
"""
import json, hashlib, collections
from decimal import Decimal
from pathlib import Path
R = Path(__file__).resolve().parent.parent
load = lambda n: json.loads((R / 'data' / f'{n}.json').read_text(encoding='utf-8'))
sec, st, h, g = load('sections'), load('stations'), load('hierarchy'), load('grid_assign')
md5 = lambda lines: hashlib.md5('\n'.join(lines).encode('utf-8')).hexdigest()
f6, f8 = (lambda x: f'{x:.6f}'), (lambda x: f'{x:.8f}')
S = sorted(sec['sections'], key=lambda s: s['id'])
sec_hash = md5([f"{s['id']}|{s['route']}|{s['from']}|{s['to']}|{f6(s['km'])}|{s['owner'] or ''}|{s['chain']}|{s['order']}" for s in S])
coord_sum = sum(Decimal(repr(c[0])) + Decimal(repr(c[1])) for s in S for c in s['coords'])
pts_hash = md5([f"{s['id']}|{len(s['coords'])}|{s['coords'][0][0]}|{s['coords'][0][1]}|{s['coords'][-1][0]}|{s['coords'][-1][1]}" for s in S])
stn = sorted(st['stations'], key=lambda s: s['id'])
st_hash = md5([f"{s['id']}|{s['name']}|{f8(s['lat'])}|{f8(s['lon'])}" for s in stn])
bmap = {(b['hq'], b['name']): b['id'] for b in sec['branches']}
bs = sorted((bmap[(q['name'], b['name'])], x['id'], x['dist_km'], x['road'] or '') for q in h['hq'] for b in q['branches'] for x in b['stations'])
bs_hash = md5([f'{a}|{b}|{f6(c)}|{d}' for a, b, c, d in bs])
gr = sorted((c[0], c[1], b) for c in g['cells'] for b in c[2])
gr_hash = md5([f'{a},{b},{c}' for a, b, c in gr])
per = md5([f'{k}={v}' for k, v in sorted(collections.Counter(s['owner'] or 'NONE' for s in S).items())])
print(f"""select
 (select count(*) from public.sections)={len(S)} as sections_count,
 (select count(*) from public.sections where owner_id is null)={sum(1 for s in S if s['owner'] is None)} as unassigned,
 (select md5(string_agg(id||'|'||route||'|'||from_name||'|'||to_name||'|'||to_char(km::numeric,'FM999999990.000000')||'|'||coalesce(owner_id,'')||'|'||chain||'|'||ord, E'\\n' order by id)) from public.sections)='{sec_hash}' as sections_fields_identical,
 (select sum((p->>0)::numeric+(p->>1)::numeric) from public.sections, jsonb_array_elements(coords) p)={coord_sum} as coord_sum_exact,
 (select md5(string_agg(id||'|'||jsonb_array_length(coords)||'|'||(coords->0->>0)||'|'||(coords->0->>1)||'|'||(coords->-1->>0)||'|'||(coords->-1->>1), E'\\n' order by id)) from public.sections)='{pts_hash}' as endpoints_identical,
 (select md5(string_agg(k||'='||c, E'\\n' order by k)) from (select coalesce(owner_id,'NONE') k, count(*) c from public.sections group by 1) t)='{per}' as per_branch_counts,
 (select count(*) from public.stations)={len(stn)} as stations_count,
 (select md5(string_agg(id||'|'||name||'|'||to_char(lat::numeric,'FM990.00000000')||'|'||to_char(lon::numeric,'FM990.00000000'), E'\\n' order by id)) from public.stations)='{st_hash}' as stations_identical,
 (select count(*) from public.branch_stations)={len(bs)} as bs_count,
 (select md5(string_agg(branch_id||'|'||station_id||'|'||to_char(dist_km::numeric,'FM999990.000000')||'|'||coalesce(road,''), E'\\n' order by branch_id, station_id)) from public.branch_stations)='{bs_hash}' as bs_identical,
 (select count(*) from public.grid_assign)={len(gr)} as grid_count,
 (select md5(string_agg(nx||','||ny||','||branch_id, E'\\n' order by nx, ny, branch_id)) from public.grid_assign)='{gr_hash}' as grid_identical;""")
