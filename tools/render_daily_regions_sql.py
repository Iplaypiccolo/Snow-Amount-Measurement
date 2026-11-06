#!/usr/bin/env python3
"""대표지점 자료로 적용 전 검토 SQL을 만든다. DB에는 연결하지 않는다."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def render(data):
    text = (ROOT/'tools/forecast_daily_regions_76.template.sql').read_text(encoding='utf-8')
    specs = [('PLACES', 'places', 'forecast_daily_places',
              'code text,city_code text,label text,lat double precision,lon double precision,land_id text,temp_id text'),
             ('HINTS', 'hints', 'forecast_daily_region_hints',
              'nx integer,ny integer,city_code text,dong_code text')]
    for marker, key, table, columns in specs:
        body = json.dumps(data[key], ensure_ascii=False, separators=(',', ':'))
        tag = '$daily_'+key+'$'
        if tag in body:
            raise ValueError('unsafe SQL delimiter in data')
        statement = f'insert into private.{table} select * from jsonb_to_recordset({tag}{body}{tag}::jsonb) as p({columns});'
        text = text.replace('--__'+marker+'__', statement)
    return text


if __name__ == '__main__':
    data = json.loads((ROOT/'data/forecast_daily_regions.json').read_text(encoding='utf-8'))
    out = ROOT/'docs/sql/forecast_daily_regions_76.review.sql'
    out.write_text(render(data), encoding='utf-8')
    print(f'{out.name}: {out.stat().st_size:,} bytes (not applied)')
