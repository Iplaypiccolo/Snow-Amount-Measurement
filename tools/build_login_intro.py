#!/usr/bin/env python3
"""
로그인 인트로 파일 만들기 — 차로차로 저장소(Iplaypiccolo/Charocharo)의 인트로를 이 사이트의 login/intro/ 로 옮깁니다.

하는 일
  1. 재생기(charo-pet.js·charo-intro.js·welcome-fx.js)와 배치표(intro-cast.js)를 그대로 복사
  2. 캐릭터 파일 6개에서 인트로에 쓰는 동작만 남기고, 그림(PNG)을 WebP 로 다시 저장해 크기를 줄임(모양·크기·위치는 그대로)
  3. 효과 그림(배경·문구·폭죽·색종이)을 복사
  4. login/intro-loader.js 안의 파일 지문 목록(V)을 갱신 — 파일이 바뀌면 브라우저가 새로 받게(꼬리표와 같은 역할)
사용(저장소 맨 위에서):  python tools/build_login_intro.py <차로차로 저장소 폴더>
  그다음 python tools/stamp_assets.py 로 첫 화면 꼬리표 갱신
"""
import base64, hashlib, io, json, re, shutil, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'login' / 'intro'
SRC = Path(sys.argv[1] if len(sys.argv) > 1 else '../Charocharo').resolve()
KB = ['kb_type', 'kb_echo', 'kb_private_in', 'kb_private_hold', 'kb_private_out', 'mt_press', 'mt_tap', 'mt_cancel']
AG = ['ag_in', 'ag_hold', 'ag_out', 'ag_out35', 'ag_out24', 'ag_out12']   # ag_out35·24·12: 검수 확정 리그(add_agent_rig.js)의 각도별 복귀   # 비밀번호 요원(차로차로 저장소 intro/tools/add_agent.js) — 있는 캐릭터만 남김   # 키보드·터치 반응(차로차로 저장소 intro/tools/add_keys.js)
CHARS = {   # 인트로 배치표의 id: (차로차로 저장소 안 파일, 남길 동작)
    'charocharo': ('charo-pet.json', ['c_breath', 'i_charo', 'i_charo_r', 'm_mouse_L', 'm_mouse_R'] + KB),
    'chumdani': ('chumdani/chumdani.json', ['c_idle', 'c_run_i', 'c_jump_i', 'c_welcome', 'c_flip', 'm_mouse_L', 'm_mouse_R'] + KB),
    'giltong': ('giltong/giltong.json', ['g_idle', 'g_run_i', 'g_welcome', 'g_finish', 'm_mouse'] + KB),
    'tira': ('tira_v3/tira_v3.json', ['t_idle', 't_intro', 't_intro_r', 'm_mouse_L', 'm_mouse_R'] + KB),
    'tarotaro': ('tarotaro/tarotaro.json', ['tt_idle', 'tt_intro', 'tt_intro_r', 'm_mouse_L', 'm_mouse_R'] + KB),
    'doroduck': ('doroduck/doroduck.json', ['d_idle', 'd_run_i', 'd_welcome', 'd_finish_i', 'm_mouse_L', 'm_mouse_R'] + KB),
}
JS = {'charo-pet.js': 'charo-pet.js', 'charo-intro.js': 'intro/charo-intro.js', 'welcome-fx.js': 'intro/welcome-fx.js', 'intro-cast.js': 'intro/intro-cast.js', 'charo-mouse.js': 'intro/charo-mouse.js'}


def webp(uri, fit=None):
    head, b64 = uri.split(',', 1)
    im = Image.open(io.BytesIO(base64.b64decode(b64))); im.load()
    if fit and im.width > 1 and im.width > fit * 1.05:   # 요원 그림(생성 원본이 커서): 그림 좌표 크기(원본 파츠와 같은 밀도)로 가로세로 같은 비율로만 줄임
        im = im.convert('RGBA').resize((round(fit), round(im.height * fit / im.width)), Image.LANCZOS)
    b = io.BytesIO(); im.convert('RGBA').save(b, 'WEBP', quality=92, method=6)
    new = 'data:image/webp;base64,' + base64.b64encode(b.getvalue()).decode()
    return new if len(new) < len(uri) else uri


def h8(p): return hashlib.md5(p.read_bytes()).hexdigest()[:8]


def main():
    if not (SRC / 'intro' / 'intro-cast.js').exists(): raise SystemExit(f'차로차로 저장소를 찾지 못함: {SRC}')
    (OUT / 'chars').mkdir(parents=True, exist_ok=True); (OUT / 'assets').mkdir(exist_ok=True)
    V, total = {}, 0
    for dst, src in JS.items():
        shutil.copy(SRC / src, OUT / dst); V[dst] = h8(OUT / dst)
    for cid, (f, keep) in CHARS.items():
        p = json.loads((SRC / f).read_text(encoding='utf-8'))
        keep = keep + [k for k in AG if any(c['id'] == k for c in p['clips'])]
        missing = [k for k in keep if not any(c['id'] == k for c in p['clips'])]
        if missing: raise SystemExit(f'{cid}: 동작 없음 {missing}')
        p['clips'] = [c for c in p['clips'] if c['id'] in keep]
        p['rules'] = []; p.pop('preview', None)   # p['mouse'](마우스 반응 설정)는 그대로 둠
        # 남긴 동작이 실제로 쓰는 그림만 남김(예전 요원 그림 v1~v3 처럼 더는 안 쓰는 변형은 빼서 가볍게; 그림 목록 자리는 그대로라 번호는 안 바뀜)
        used = set()
        for pt in p['parts']:
            ims = pt['images']
            idx = {pt['rest'].get('img', 0) or 0, 0}
            for c in p['clips']:
                for k in (c['tracks'].get(pt['id'], {}).get('img') or []): idx.add(k['v'])
            for i in idx:
                if 0 <= i < len(ims): used.add(ims[i]['asset'])
        BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='   # 1×1 투명(재생기가 모든 그림이 열렸는지 확인하므로 자리만 채움)
        p['assets'] = {k: (v if k in used else BLANK) for k, v in p['assets'].items()}
        drawn = {}
        for pt in p['parts']:
            for v in pt['images']: drawn[v['asset']] = max(drawn.get(v['asset'], 0), v['w'])
        rig = set()   # 검수 확정 리그(1254×1254 전체 캔버스 그림): 긴 변 900px 로 줄임(캔버스 통째로 줄여 좌표는 그대로, 여백 자르지 않음)
        for pt in p['parts']:
            if pt['id'] in ((p.get('agent') or {}).get('rig') or {}).get('parts', []): rig.update(v['asset'] for v in pt['images'])
        def fit(k):   # 요원 그림: 그림 좌표 크기(원본 파츠와 같은 밀도), 35도 새 그림(cam4_)은 긴 변 700px 까지(로그인 화면에서 친구 키 최대 수백 px)
            if k in rig: return 900 if drawn.get(k, 0) else None   # 검수 확정 리그: 900px(PC 화면에서 캔버스가 약 440 CSS px → 고해상도 화면 약 880px)
            if k.startswith('cam4_'): return 700 if drawn.get(k, 0) else None
            return drawn.get(k) if '_agent_' in k else None
        p['assets'] = {k: webp(v, fit(k)) if v.startswith('data:image/png') else v for k, v in p['assets'].items()}
        out = OUT / 'chars' / (cid + '.json')
        out.write_text(json.dumps(p, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        V[cid] = h8(out); total += out.stat().st_size
        print(f'{cid:11s} {(SRC / f).stat().st_size // 1024:5d} KB → {out.stat().st_size // 1024:5d} KB')
    for a in (SRC / 'intro' / 'assets').iterdir():
        shutil.copy(a, OUT / 'assets' / a.name); total += a.stat().st_size
    V['fx'] = hashlib.md5(b''.join((OUT / 'assets' / n).read_bytes() for n in sorted(x.name for x in (OUT / 'assets').iterdir()))).hexdigest()[:8]
    loader = ROOT / 'login' / 'intro-loader.js'
    s = loader.read_text(encoding='utf-8')
    s2 = re.sub(r'/\*@@V@@\*/\{[^}]*\}', '/*@@V@@*/' + json.dumps(V, separators=(',', ':')), s)
    if s2 != s: loader.write_text(s2, encoding='utf-8')
    print(f'캐릭터+효과 합계 {total // 1024} KB, 지문 {V}')


if __name__ == '__main__':
    main()
