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
KB = ['kb_type', 'kb_echo', 'kb_private_in', 'kb_private_hold', 'kb_private_out', 'mt_press', 'mt_tap', 'mt_cancel']   # 키보드·터치 반응(차로차로 저장소 intro/tools/add_keys.js)
CHARS = {   # 인트로 배치표의 id: (차로차로 저장소 안 파일, 남길 동작)
    'charocharo': ('charo-pet.json', ['c_breath', 'i_charo', 'i_charo_r', 'm_mouse_L', 'm_mouse_R'] + KB),
    'chumdani': ('chumdani/chumdani.json', ['c_idle', 'c_run_i', 'c_jump_i', 'c_welcome', 'c_flip', 'm_mouse_L', 'm_mouse_R'] + KB),
    'giltong': ('giltong/giltong.json', ['g_idle', 'g_run_i', 'g_welcome', 'g_finish', 'm_mouse'] + KB + ['ag_in', 'ag_hold', 'ag_out']),   # ag_ = 비밀번호 요원(intro/tools/add_agent.js)
    'tira': ('tira_v3/tira_v3.json', ['t_idle', 't_intro', 't_intro_r', 'm_mouse_L', 'm_mouse_R'] + KB),
    'tarotaro': ('tarotaro/tarotaro.json', ['tt_idle', 'tt_intro', 'tt_intro_r', 'm_mouse_L', 'm_mouse_R'] + KB),
    'doroduck': ('doroduck/doroduck.json', ['d_idle', 'd_run_i', 'd_welcome', 'd_finish_i', 'm_mouse_L', 'm_mouse_R'] + KB),
}
JS = {'charo-pet.js': 'charo-pet.js', 'charo-intro.js': 'intro/charo-intro.js', 'welcome-fx.js': 'intro/welcome-fx.js', 'intro-cast.js': 'intro/intro-cast.js', 'charo-mouse.js': 'intro/charo-mouse.js'}


def webp(uri, fit=None):
    head, b64 = uri.split(',', 1)
    im = Image.open(io.BytesIO(base64.b64decode(b64))); im.load()
    if fit and im.width > fit * 1.05:   # 요원 그림(생성 원본이 커서): 그림 좌표 크기(원본 파츠와 같은 밀도)로 가로세로 같은 비율로만 줄임
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
        missing = [k for k in keep if not any(c['id'] == k for c in p['clips'])]
        if missing: raise SystemExit(f'{cid}: 동작 없음 {missing}')
        p['clips'] = [c for c in p['clips'] if c['id'] in keep]
        p['rules'] = []; p.pop('preview', None)   # p['mouse'](마우스 반응 설정)는 그대로 둠
        drawn = {}
        for pt in p['parts']:
            for v in pt['images']: drawn[v['asset']] = max(drawn.get(v['asset'], 0), v['w'])
        p['assets'] = {k: webp(v, drawn.get(k) if k.startswith('g_agent_') else None) if v.startswith('data:image/png') else v for k, v in p['assets'].items()}
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
