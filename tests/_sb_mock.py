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
        self.requests, self.rid, self.req_calls = [], 0, []          # 구간 변경 요청(jurisdiction_requests)
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
    def add_request(self, branch_id, section_ids, to=None, reason=None, status="pending", snapshot=None, created_at="2026-10-03T01:00:00Z", note=None):
        """화면 시험에서 미리 넣어 두는 구간 변경 요청"""
        self.rid += 1
        row = {"id": self.rid, "created_at": created_at, "requested_by": None, "branch_id": branch_id, "section_ids": list(section_ids),
               "snapshot": snapshot if snapshot is not None else [{"id": i, "route": "경부선", "from": "A", "to": "B", "km": 2.0, "owner": branch_id} for i in section_ids],
               "to_branch_id": to, "reason": reason, "status": status, "resolved_by": None, "resolved_at": None, "resolution_note": note}
        self.requests.append(row); return row
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
    def requests_api(self, route, req, u, q, body, send):
        """구간 변경 요청 표와 같은 권한 규칙을 흉내: 지사만 요청·자기 지사 것만 읽기·관리자만 승인/반려·지사는 자기 대기 요청만 취소"""
        import re as _re
        p = u["profile"]; usable = self.usable(u); is_branch = usable and p["role"] == "branch"; is_admin = self.active_admin(u)
        self.req_calls.append((req.method, req.url.split("?", 1)[-1] if "?" in req.url else "", body))
        if getattr(self, "req_fail", None) and req.method != "GET": return send(*self.req_fail)
        def visible(): return list(self.requests) if is_admin else [r for r in self.requests if is_branch and r["branch_id"] == p["branch_id"]]
        if req.method == "GET":
            rows = visible(); st = q.get("status", [""])[0]
            if st.startswith("eq."): rows = [r for r in rows if r["status"] == st[3:]]
            return send(200, sorted(rows, key=lambda r: -r["id"])[: int(q.get("limit", ["200"])[0])])
        if req.method == "POST":
            if not is_branch: return send(403, {"code": "42501", "message": "new row violates row-level security policy"})
            ids = body.get("section_ids") or []
            if not (1 <= len(ids) <= 60 and all(_re.fullmatch(r"S[0-9]{4}", i) for i in ids)) or len(body.get("reason") or "") > 200: return send(400, {"code": "23514", "message": "check violation"})
            if len([r for r in self.requests if r["branch_id"] == p["branch_id"] and r["status"] == "pending"]) >= 20: return send(400, {"code": "54000", "message": "too many pending requests"})
            row = self.add_request(p["branch_id"], ids, to=body.get("to_branch_id"), reason=body.get("reason"), snapshot=body.get("snapshot") or [], created_at="2026-10-03T02:00:00Z")
            row["requested_by"] = u["id"]; return send(201, [row])
        if req.method == "PATCH":
            idf = q.get("id", [""])[0]; stf = q.get("status", [""])[0]
            ids = [int(x) for x in _re.findall(r"\d+", idf)] if idf.startswith(("eq.", "in.")) else []
            rows = [r for r in visible() if r["id"] in ids and (not stf.startswith("eq.") or r["status"] == stf[3:])]
            out = []
            for r in rows:
                if r["status"] != "pending": return send(403, {"code": "42501", "message": "request already resolved"})
                new = body.get("status")
                if is_admin and new in ("approved", "rejected"): r["resolution_note"] = body.get("resolution_note")
                elif is_branch and new == "cancelled" and r["requested_by"] == u["id"]: pass
                else: return send(403, {"code": "42501", "message": "not allowed"})
                r["status"] = new; r["resolved_by"] = u["id"]; r["resolved_at"] = "2026-10-03T03:00:00Z"; out.append(r)
            return send(200, out)
        return send(405, {"message": "no"})
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
            if tbl == "jurisdiction_requests": return self.requests_api(route, req, u, q, body, send)
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
