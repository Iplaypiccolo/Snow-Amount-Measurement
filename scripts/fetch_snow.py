#!/usr/bin/env python3
"""
기상청 API허브에서 적설 데이터를 받아 data/snow_data.json을 갱신한다.

사용법:
  python fetch_snow.py daily            # 어제 날짜 하루치만 갱신 (매일 자동 실행용)
  python fetch_snow.py backfill 10      # 최근 N개 시즌 전체를 처음부터 새로 받음 (1회성)

환경변수:
  KMA_AUTH_KEY : 기상청 API허브 인증키 (필수)
"""
import sys
import os
import json
import time
from datetime import date, timedelta
import urllib.request
import urllib.parse

AUTH_KEY = os.environ.get("KMA_AUTH_KEY")
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
SNOW_DATA_PATH = os.path.join(DATA_DIR, "snow_data.json")
HIERARCHY_PATH = os.path.join(DATA_DIR, "hierarchy.json")


def season_label(start_year):
    return f"{start_year}-11-15~{start_year+1}-03-15"


def season_date_range(start_year):
    d = date(start_year, 11, 15)
    end = date(start_year + 1, 3, 15)
    out = []
    while d <= end:
        out.append(d.strftime("%Y%m%d"))
        d += timedelta(days=1)
    return out


def season_start_year_for_date(d: date):
    """해당 날짜가 어느 시즌(11.15~익년3.15)에 속하는지, 아니면 범위 밖인지"""
    if d.month in (11, 12):
        return d.year
    if d.month <= 3:
        # 3/15 이후는 시즌 범위 밖으로 취급 (3/16~10월)
        if d.month == 3 and d.day > 15:
            return None
        return d.year - 1
    return None


def fetch_hour(date_str, hour_str):
    """특정 날짜/시각의 sd=day 스냅샷을 받아 {stn_id: sd} 딕셔너리로 반환"""
    tm = f"{date_str}{hour_str}00"
    params = urllib.parse.urlencode({
        "sd": "day", "tm": tm, "help": "0", "authKey": AUTH_KEY
    })
    url = f"https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as res:
        raw = res.read()
    try:
        text = raw.decode("euc-kr")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")

    result = {}
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 7:
            continue
        try:
            stn_id = int(parts[1])
            sd = float(parts[6])
        except ValueError:
            continue
        result[stn_id] = sd
    return result


def fetch_day_max(date_str):
    """00~23시 24회 조회해서 관측소별 그날 최댓값 딕셔너리 반환"""
    day_max = {}
    for h in range(24):
        hh = f"{h:02d}"
        try:
            hour_data = fetch_hour(date_str, hh)
        except Exception as e:
            print(f"  {date_str} {hh}시 요청 실패: {e}", file=sys.stderr)
            continue
        for stn_id, sd in hour_data.items():
            if stn_id not in day_max or sd > day_max[stn_id]:
                day_max[stn_id] = sd
        time.sleep(0.15)
    return day_max


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def branch_station_map(hierarchy):
    m = {}
    for hq in hierarchy["hq"]:
        for br in hq["branches"]:
            key = f"{hq['name']}|||{br['name']}"
            m[key] = [s["id"] for s in br["stations"]]
    return m


def ensure_season(snow_data, start_year):
    label = season_label(start_year)
    if label not in snow_data["seasons"]:
        dates = season_date_range(start_year)
        branches = {}
        snow_data["seasons"][label] = {"dates": dates, "branches": branches}
    return snow_data["seasons"][label]


def apply_day_to_season(snow_data, hierarchy_map, start_year, date_str, day_max):
    season = ensure_season(snow_data, start_year)
    if date_str not in season["dates"]:
        return
    di = season["dates"].index(date_str)

    # station_data 갱신
    for stn_id, sd in day_max.items():
        key = str(stn_id)
        snow_data["stationData"].setdefault(key, {})[date_str] = sd

    # 지사별 그날 최댓값 재계산
    for br_key, stn_ids in hierarchy_map.items():
        vals = [day_max[s] for s in stn_ids if s in day_max]
        arr = season["branches"].setdefault(br_key, [None] * len(season["dates"]))
        if len(arr) < len(season["dates"]):
            arr = arr + [None] * (len(season["dates"]) - len(arr))
        arr[di] = max(vals) if vals else arr[di]
        season["branches"][br_key] = arr


def run_daily():
    yesterday = date.today() - timedelta(days=1)
    start_year = season_start_year_for_date(yesterday)
    if start_year is None:
        print(f"{yesterday} 는 11.15~3.15 시즌 범위 밖이라 스킵합니다.")
        return

    snow_data = load_json(SNOW_DATA_PATH)
    hierarchy = load_json(HIERARCHY_PATH)
    hmap = branch_station_map(hierarchy)

    date_str = yesterday.strftime("%Y%m%d")
    print(f"{date_str} 데이터 수집 중...")
    day_max = fetch_day_max(date_str)
    print(f"  관측소 {len(day_max)}개 반영")
    apply_day_to_season(snow_data, hmap, start_year, date_str, day_max)
    save_json(SNOW_DATA_PATH, snow_data)
    print("완료")


def run_backfill(n_seasons, force=False):
    today = date.today()
    latest_start_year = season_start_year_for_date(today)
    if latest_start_year is None:
        # 현재 시즌 밖이면 가장 최근에 끝난 시즌부터
        latest_start_year = today.year - 1 if today.month < 11 else today.year

    snow_data = load_json(SNOW_DATA_PATH) if os.path.exists(SNOW_DATA_PATH) else {"seasons": {}, "stationData": {}}
    hierarchy = load_json(HIERARCHY_PATH)
    hmap = branch_station_map(hierarchy)

    for i in range(n_seasons):
        start_year = latest_start_year - i
        label = season_label(start_year)

        if not force and label in snow_data["seasons"] and len(snow_data["seasons"][label].get("dates", [])) > 0:
            print(f"=== 시즌 {label} 이미 존재함 - 스킵 (강제로 다시 받으려면 --force) ===")
            continue

        dates = season_date_range(start_year)
        # 이미 오늘(미래) 이후 날짜는 스킵
        dates = [d for d in dates if d <= today.strftime("%Y%m%d")]
        print(f"=== 시즌 {label} 백필 시작 ({len(dates)}일) ===")
        for date_str in dates:
            print(f"{date_str} 수집 중...")
            day_max = fetch_day_max(date_str)
            apply_day_to_season(snow_data, hmap, start_year, date_str, day_max)
            # 시즌 하나 끝날 때마다 중간 저장 (중단되어도 이어서 가능)
            save_json(SNOW_DATA_PATH, snow_data)
        print(f"=== 시즌 {label} 완료 ===")

    print("백필 전체 완료")


if __name__ == "__main__":
    if not AUTH_KEY:
        print("KMA_AUTH_KEY 환경변수가 필요합니다.", file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1] if len(sys.argv) > 1 else "daily"
    if mode == "backfill":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        force = "--force" in sys.argv
        run_backfill(n, force=force)
    else:
        run_daily()
