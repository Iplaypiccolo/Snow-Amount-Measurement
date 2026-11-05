"""기존 1km 샘플링 기준의 구간별 예보 격자. 관할 소속과 분리해 생성한다."""
import json
from pathlib import Path
from build_grid_assign import densify, to_grid

ROOT = Path(__file__).resolve().parent.parent


def build(doc):
    return {s['id']: sorted({to_grid(lat, lon) for lon, lat in densify(s['coords'])
                            if 1 <= to_grid(lat, lon)[0] <= 149 and 1 <= to_grid(lat, lon)[1] <= 253})
            for s in doc['sections']}


if __name__ == '__main__':
    doc = json.loads((ROOT/'data/sections.json').read_text(encoding='utf-8'))
    cells = build(doc)
    (ROOT/'data/section_grid.json').write_text(json.dumps({'version': 1, 'stepKm': 1, 'sections': cells}, separators=(',', ':')), encoding='utf-8')
    print(f'{len(cells)} sections / {sum(map(len, cells.values()))} section-cell pairs')
