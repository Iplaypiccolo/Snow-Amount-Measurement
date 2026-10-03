"""
가짜 Supabase 서버 — 실제 Supabase 에 접속하지 않고 시험하기 위한 흉내 (tests/test_admin_ui.py, test_login_gate.py, 기존 화면 시험이 함께 씀)
흉내 내는 것: 로그인·토큰 갱신·로그아웃, 내 정보/계정 목록/지사·본부/접속 로그 읽기(권한 규칙 포함), 비밀번호 변경, 계정 발급 함수(일괄 설정·초기화·비활성화)
"""
import json, re, time
from urllib.parse import urlparse, parse_qs

SB = "https://yzwbnohzhnctdvufntig.supabase.co"
DOMAIN = "snow-support.invalid"
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}
ADMIN_PW = "Admin#Pass-2026x!"
TEMP_PW = "Tmp#Start-Ab12Cd34"

class Mock:
    def __init__(self):
        self.users, self.tokens, self.fn_calls, self.put_calls, self.n = {}, {}, [], [], 0
        self.fn_override = None; self.delay = 0
        self.add("admin-01", "관리자1", "admin", None, ADMIN_PW)
        self.add("admin-02", "관리자2", "admin", None, "Second#Admin-77qZ")
        names = [("exchungju", "충주지사", "B019", "H04"), ("exdongseoul", "동서울지사", "B006", "H02"), ("exgurye", "구례지사", "B039", "H07"), ("exwonju", "원주지사", "B011", "H03"),
                 ("exincheon", "인천지사", "B001", "H01"), ("exsiheung", "시흥지사", "B002", "H01"), ("exgunpo", "군포지사", "B003", "H01"), ("exhwaseong", "화성지사", "B004", "H01")]
        for u, d, b, h in names: self.add(u, d, "branch", b, TEMP_PW, must_change=True)
        self.add("equip-01", "지원장비", "equip", None, "Equip#Pass-8821xY")
        self.branches = [{"id": b, "name": d.replace("지사", ""), "hq_id": h} for _, d, b, h in names]
        self.hqs = [{"id": "H01", "name": "수도권", "sort": 1}, {"id": "H02", "name": "서울경기", "sort": 2}, {"id": "H03", "name": "강원", "sort": 3}, {"id": "H04", "name": "충북", "sort": 4}, {"id": "H07", "name": "광주전남", "sort": 7}]
        self.users["stranger"] = {"id": "id-stranger", "username": "stranger", "password": "Stranger#Pass-123", "profile": None}
        self.add("exdisabled", "비활성지사", "branch", "B001", "Disabled#Pass-123q", disabled=True)
        self.audit = [{"id": 3, "at": "2026-10-02T14:22:22Z", "username": "bootstrap", "role": None, "kind": "계정생성", "tab": "account-admin", "target": "exchungju (branch:B019)", "ip": "203.0.113.5"},
                      {"id": 2, "at": "2026-10-02T14:21:44Z", "username": "bootstrap", "role": None, "kind": "계정생성", "tab": "account-admin", "target": "admin-02 (admin)", "ip": "203.0.113.5"},
                      {"id": 1, "at": "2026-10-02T13:00:00Z", "username": "admin-01", "role": "admin", "kind": "수정", "tab": "vehicles", "target": "vehicles:11가1111", "ip": "198.51.100.2"}]
    def add(self, username, display, role, branch, pw, must_change=False, disabled=False):
        self.n += 1
        self.users[username] = {"id": f"id-{username}", "username": username, "password": pw,
            "profile": {"id": f"id-{username}", "username": username, "display_name": display, "role": role, "branch_id": branch, "must_change": must_change, "disabled": disabled}}
    def by_token(self, req):
        m = re.match(r"Bearer (.+)", req.headers.get("authorization", ""))
        uid = self.tokens.get(m.group(1)) if m else None
        return next((u for u in self.users.values() if u["id"] == uid), None)
    def issue(self, u):
        self.n += 1; at, rt = f"at-{self.n}", f"rt-{self.n}"; self.tokens[at] = u["id"]; self.tokens[rt] = u["id"]
        return {"access_token": at, "refresh_token": rt, "expires_in": 3600, "token_type": "bearer", "user": {"id": u["id"]}}
    def active_admin(self, u): p = u and u["profile"]; return bool(p and p["role"] == "admin" and not p["must_change"] and not p["disabled"])
    def usable(self, u): p = u and u["profile"]; return bool(p and not p["must_change"] and not p["disabled"])
    def handle(self, route):
        req = route.request; url = urlparse(req.url); path, q = url.path, parse_qs(url.query)
        def send(status, body=None, extra=None):
            h = {**CORS, "content-type": "application/json"}; h.update(extra or {})
            route.fulfill(status=status, headers=h, body=json.dumps(body) if body is not None else "")
        if getattr(self, 'down', False): return route.abort()          # 서버에 연결할 수 없는 상황 흉내
        if req.method == "OPTIONS": return route.fulfill(status=204, headers=CORS)
        if self.delay: __import__('time').sleep(self.delay)         # 느린 서버 흉내
        body = json.loads(req.post_data) if req.post_data else None
        if path == "/auth/v1/token" and q.get("grant_type") == ["password"]:
            email = (body or {}).get("email", ""); name = email.split("@")[0]; u = self.users.get(name)
            if not u or email != f"{name}@{DOMAIN}" or u["password"] != body.get("password"): return send(400, {"error_code": "invalid_credentials", "msg": "Invalid login credentials"})
            return send(200, self.issue(u))
        if path == "/auth/v1/token" and q.get("grant_type") == ["refresh_token"]:
            uid = self.tokens.get(body.get("refresh_token")); u = next((x for x in self.users.values() if x["id"] == uid), None)
            return send(200, self.issue(u)) if u else send(400, {"error_code": "refresh_token_not_found"})
        if path == "/auth/v1/logout": return send(204)
        u = self.by_token(req)
        if path == "/auth/v1/user" and req.method == "PUT":
            if not u: return send(401, {"msg": "bad jwt"})
            self.put_calls.append(body)
            if body.get("current_password") != u["password"]: return send(400, {"error_code": "current_password_mismatch", "msg": "Incorrect current password"})
            if len(body.get("password", "")) < 12: return send(422, {"error_code": "weak_password"})
            u["password"] = body["password"]; u["profile"]["must_change"] = False       # DB 트리거 흉내
            return send(200, {"id": u["id"]})
        if path.startswith("/rest/v1/"):
            if not u: return send(401, {"message": "JWT required"})
            tbl = path.split("/")[-1]; idf = q.get("id", [""])[0]
            if tbl == "profiles":
                if idf.startswith("eq."): rows = [x["profile"] for x in self.users.values() if x["id"] == idf[3:] and x["profile"]]
                elif self.active_admin(u): rows = sorted([x["profile"] for x in self.users.values() if x["profile"]], key=lambda p: p["username"])
                else: rows = [u["profile"]] if u["profile"] else []
                if not idf.startswith("eq.") and not self.active_admin(u): rows = [r for r in rows if r["id"] == u["id"]]
                return send(200, rows)
            if tbl in ("branches", "hqs"): return send(200, (self.branches if tbl == "branches" else self.hqs) if self.usable(u) else [])
            if tbl == "audit_log":
                rows = self.audit if self.active_admin(u) else []
                k = q.get("kind", [""])[0]
                if k.startswith("eq."): rows = [r for r in rows if r["kind"] == k[3:]]
                return send(200, rows)
            return send(404, {"message": "no table"})
        if path == "/functions/v1/account-admin":
            if not self.active_admin(u): return send(403, {"ok": False, "error": "forbidden", "message": "관리자만 할 수 있는 작업입니다."})
            self.fn_calls.append(body)
            if self.fn_override:
                r = self.fn_override(body)
                if r: return send(*r)
            a = body.get("action")
            if a == "set_passwords":
                for it in body["items"]:
                    x = self.users.get(it["username"]); x["password"] = it["password"]; x["profile"]["must_change"] = body.get("require_change", True)
                return send(200, {"ok": True, "updated": len(body["items"]), "failed": [], "require_change": body.get("require_change", True)})
            if a == "reset":
                x = self.users[body["username"]]; x["password"] = "Tmp#Reset-Zx98Yw76"; x["profile"]["must_change"] = True
                return send(200, {"ok": True, "username": x["username"], "creds": [{"username": x["username"], "temp_password": "Tmp#Reset-Zx98Yw76"}]})
            if a in ("disable", "enable"):
                x = self.users[body["username"]]; x["profile"]["disabled"] = (a == "disable"); return send(200, {"ok": True, "username": x["username"], "disabled": a == "disable"})
            return send(400, {"ok": False, "error": "bad_action", "message": "알 수 없는 작업"})
        return send(404, {"message": "unknown"})


def session_for(mock, username, persist=True, auto_days=30):
    """이미 로그인한 상태의 저장소 내용을 만들어 줌 (화면 시험이 로그인 과정을 건너뛸 때 사용)"""
    u = mock.users[username]; tok = mock.issue(u)
    return {"access_token": tok["access_token"], "refresh_token": tok["refresh_token"], "expires_at": int(time.time() * 1000) + 3600 * 1000,
            "user_id": u["id"], "persist": persist, "auto_until": int(time.time() * 1000) + auto_days * 86400 * 1000, "username": username}

def install(page, mock, username="admin-01"):
    """페이지에 가짜 서버를 연결하고, 해당 계정으로 이미 로그인한 상태로 시작하게 함"""
    page.route(SB + "/**", mock.handle)
    s = session_for(mock, username)
    page.add_init_script("try { localStorage.setItem('ss_session', %s); } catch (e) {}" % json.dumps(json.dumps(s)))
    return s
