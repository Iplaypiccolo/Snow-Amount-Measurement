"""2km means distance to a cell polygon, not to its center or an eight-cell ring."""
import json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'tools'))
from build_section_grid import build,sampled
from build_grid_names import from_grid

def coords(x,y):
    lat,lon=from_grid(x,y)
    return [lon,lat]

fixtures={'sections':[{'id':'center','coords':[coords(60,127),coords(60.01,127)]},
                      {'id':'edge','coords':[coords(60.45,127),coords(60.46,127)]}]}
actual=build(fixtures,2)
checks=[('중심 근처 도로는 2km 밖의 인접 칸을 모두 넣지 않음',set(actual['center'])=={(60,127)}),
        ('가장자리 도로는 중심이 2km 밖이어도 접촉하는 이웃 칸 포함',set(actual['edge'])=={(60,127),(61,127)})]
doc=json.loads((ROOT/'data/sections.json').read_text(encoding='utf-8'))
data=json.loads((ROOT/'data/section_grid.json').read_text(encoding='utf-8'))
old=sampled(doc)
checks.append(('모든 원본 도로 샘플 격자를 확대 자료가 포함',data['radiusKm']==2 and all(set(old[s])<=set(map(tuple,data['sections'][s])) for s in old)))
for name,ok in checks:print(('PASS ' if ok else 'FAIL ')+name)
print(f'{sum(ok for _,ok in checks)}/{len(checks)} 통과')
sys.exit(0 if all(ok for _,ok in checks) else 1)
