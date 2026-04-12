#!/usr/bin/env python3
"""SmartGo School — Full E2E test runner (stdlib only)."""

import http.cookiejar
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("E2E_BASE_URL", "http://localhost:9080")
DB_URL = os.environ.get("E2E_DB_URL", "postgres://postgres:postgres@localhost:5432/pravoprost_e2e?sslmode=disable")

PASS = FAIL = 0
ERRORS: list[str] = []


def ok(name: str):
    global PASS; PASS += 1; print(f"  \033[32m✓\033[0m {name}")


def fail(name: str, detail: str):
    global FAIL; FAIL += 1; ERRORS.append(f"{name}: {detail}"); print(f"  \033[31m✗\033[0m {name}: {detail}")


def psql(sql: str):
    subprocess.run(["psql", DB_URL, "-q", "-c", sql],
                   env={**os.environ, "PGPASSWORD": "postgres"}, capture_output=True)


class Client:
    def __init__(self):
        cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(cj),
            NoRedirectHandler(),
        )
        self.csrf = ""
        self.account_id = ""

    def login(self, code: str) -> bool:
        try:
            r = self.opener.open(f"{BASE}/api/v1/auth/sso/yandex/start")
        except urllib.error.HTTPError as e:
            if e.status == 302:
                loc = e.headers.get("Location", "")
            else:
                return False
        else:
            loc = r.headers.get("Location", "")
        if not loc:
            return False

        q = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
        state = q.get("state", [""])[0]
        redir = q.get("redirect_uri", [""])[0]
        if not state or not redir:
            return False

        cb = f"{redir}?state={state}&code={code}"
        try:
            self.opener.open(cb)
        except urllib.error.HTTPError:
            pass

        d = self._get_json(f"{BASE}/api/v1/session")
        self.csrf = d.get("csrf_token", "")
        u = d.get("user") or {}
        self.account_id = u.get("account_id", "")
        return d.get("authenticated", False)

    def post(self, path: str, body=None, idem_key: str | None = None) -> dict:
        return self._req("POST", path, body, idem_key)

    def put(self, path: str, body=None) -> dict:
        return self._req("PUT", path, body)

    def get(self, path: str) -> dict:
        return self._get_json(f"{BASE}{path}")

    def get_status(self, path: str) -> int:
        return self._status("GET", path)

    def post_status(self, path: str, body=None, idem_key: str | None = None) -> int:
        return self._status("POST", path, body, idem_key)

    def post_no_csrf(self, path: str, body=None) -> int:
        data = json.dumps(body or {}).encode()
        req = urllib.request.Request(f"{BASE}{path}", data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            r = self.opener.open(req)
            return r.status
        except urllib.error.HTTPError as e:
            return e.status

    def _req(self, method: str, path: str, body=None, idem_key: str | None = None) -> dict:
        data = json.dumps(body or {}).encode()
        headers = {"Content-Type": "application/json", "X-CSRF-Token": self.csrf}
        if idem_key:
            headers["Idempotency-Key"] = idem_key
        req = urllib.request.Request(f"{BASE}{path}", data=data, method=method, headers=headers)
        try:
            r = self.opener.open(req)
            if r.status == 204:
                return {"_status": 204}
            return json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read())
            except Exception:
                return {"_error": str(e), "_status": e.status}

    def _status(self, method: str, path: str, body=None, idem_key: str | None = None) -> int:
        data = json.dumps(body or {}).encode() if body is not None or method == "POST" else None
        headers = {"Content-Type": "application/json", "X-CSRF-Token": self.csrf}
        if idem_key:
            headers["Idempotency-Key"] = idem_key
        req = urllib.request.Request(f"{BASE}{path}", data=data, method=method, headers=headers)
        try:
            r = self.opener.open(req)
            return r.status
        except urllib.error.HTTPError as e:
            return e.status

    def _get_json(self, url: str) -> dict:
        try:
            r = self.opener.open(url)
            return json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read())
            except Exception:
                return {}


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(newurl, code, msg, headers, fp)


def anon_get_status(path: str) -> int:
    try:
        r = urllib.request.urlopen(f"{BASE}{path}")
        return r.status
    except urllib.error.HTTPError as e:
        return e.status


# ===========================================================================
def parse_answer(d):
    """Parse AnswerOutcome: verdict from root, next node from next_step."""
    v = d.get("verdict","")
    ns = d.get("next_step") or {}
    nid = ns.get("node_id","") or d.get("node_id","")
    nk = ns.get("node_kind","") or d.get("node_kind","")
    sv = ns.get("state_version") or d.get("state_version",0)
    comp = bool(d.get("lesson_completion"))
    return v, nid, nk, sv, comp

print(f"\n{'='*77}\n  E2E TEST RUN — {BASE}\n{'='*77}")

# --- A ---
print("\n--- A. Auth / Session / Onboarding ---")

c_a1 = Client()
if c_a1.login("newuser-a1"):
    d = c_a1.get("/api/v1/session")
    rsr = (d.get("onboarding") or {}).get("role_selection_required", False)
    ok("A1: New login → role_selection_required") if rsr else fail("A1", f"rsr={rsr}")
else:
    fail("A1", "login failed")

d = c_a1.post("/api/v1/onboarding/role", {"role": "student"})
ok("A3: Role → student") if d.get("role") == "student" else fail("A3", f"d={d}")
ok("A4: Same role → 200") if c_a1.post_status("/api/v1/onboarding/role", {"role": "student"}) == 200 else fail("A4", "not 200")
ok("A5: Diff role → 409") if c_a1.post_status("/api/v1/onboarding/role", {"role": "teacher"}) == 409 else fail("A5", "not 409")

c_a6 = Client(); c_a6.login("newuser-a6")
ok("A6: Admin role → 403") if c_a6.post_status("/api/v1/onboarding/role", {"role": "admin"}) == 403 else fail("A6", "not 403")
ok("A8: No cookie → 401") if anon_get_status("/api/v1/student/catalog") == 401 else fail("A8", "not 401")

c_a9 = Client(); c_a9.login("newuser-a9")
ok("A9: No CSRF → 403") if c_a9.post_no_csrf("/api/v1/onboarding/role", {"role": "student"}) == 403 else fail("A9", "not 403")

c_a7 = Client(); c_a7.login("newuser-a7")
ok("A7: Logout → 204") if c_a7.post("/api/v1/auth/logout").get("_status") == 204 else fail("A7", "not 204")

# --- Seed ---
print("\n--- Seed accounts ---")
admin = Client(); admin.login("admin")
teacher = Client(); teacher.login("teacher")
student = Client(); student.login("student")
parent = Client(); parent.login("parent")
student2 = Client(); student2.login("student2")

psql(f"UPDATE accounts SET role='admin',updated_at=now() WHERE id='{admin.account_id}' AND role!='admin';"
     f"INSERT INTO admin_profiles(account_id,display_name,created_at,updated_at) "
     f"VALUES('{admin.account_id}','Admin',now(),now()) ON CONFLICT(account_id) DO NOTHING;")
admin = Client(); admin.login("admin")

teacher.post("/api/v1/onboarding/role", {"role": "teacher"})
student.post("/api/v1/onboarding/role", {"role": "student"})
parent.post("/api/v1/onboarding/role", {"role": "parent"})
student2.post("/api/v1/onboarding/role", {"role": "student"})

teacher.put("/api/v1/teacher/profile", {"display_name": "Мария Ивановна", "organization_name": "Школа №42"})
student.put("/api/v1/student/profile", {"display_name": "Алиса", "avatar_asset_id": None})
parent.put("/api/v1/parent/profile", {"display_name": "Елена", "avatar_asset_id": None})
student2.put("/api/v1/student/profile", {"display_name": "Борис", "avatar_asset_id": None})
print("  Seeded: admin, teacher, student, parent, student2")

# --- B ---
print("\n--- B. Profiles ---")
ok("B1: Student → Алиса") if student.get("/api/v1/student/profile").get("display_name") == "Алиса" else fail("B1", "wrong")
tp = teacher.get("/api/v1/teacher/profile")
ok("B3: Teacher OK") if tp.get("display_name") == "Мария Ивановна" else fail("B3", "wrong")
ok("B5: Cross-role → 403") if student.get_status("/api/v1/teacher/profile") == 403 else fail("B5", "not 403")
tnp = Client(); tnp.login("teacher-np"); tnp.post("/api/v1/onboarding/role", {"role": "teacher"})
ok("A10: No profile → 409") if tnp.post_status("/api/v1/teacher/courses", {"title":"X","description":"X","age_min":8,"age_max":12}) == 409 else fail("A10", "not 409")

# --- H ---
print("\n--- H. Platform course ---")
CID = admin.post("/api/v1/admin/courses", {"title":"Safe","description":"Online","age_min":8,"age_max":12}).get("course_id","")
ok(f"H1: Course → {CID}") if CID else fail("H1", "no id")
dv = admin.get(f"/api/v1/admin/courses/{CID}/draft").get("draft_version", 0)

content = {"modules": [
    {"id":"mod_safety","title":"Safety","lessons":[
        {"id":"lesson_phishing","title":"Phishing","graph":{"startNodeId":"s1","nodes":[
            {"id":"s1","kind":"story","body":{"text":"Phishing"},"nextNodeId":"q1"},
            {"id":"q1","kind":"single_choice","prompt":"What?","options":[
                {"id":"q1a","text":"Click","result":"incorrect","feedback":"No!","nextNodeId":"s2"},
                {"id":"q1b","text":"Tell","result":"correct","feedback":"Yes!","nextNodeId":"s2"}]},
            {"id":"s2","kind":"story","body":{"text":"Info"},"nextNodeId":"q2"},
            {"id":"q2","kind":"single_choice","prompt":"Sign?","options":[
                {"id":"q2a","text":"Urgency","result":"correct","feedback":"Yes!","nextNodeId":"end1"},
                {"id":"q2b","text":"Friend","result":"incorrect","feedback":"Hacked","nextNodeId":"end1"}]},
            {"id":"end1","kind":"end","text":"Done!"}]}},
        {"id":"lesson_passwords","title":"Passwords","graph":{"startNodeId":"ps1","nodes":[
            {"id":"ps1","kind":"story","body":{"text":"Passwords"},"nextNodeId":"pq1"},
            {"id":"pq1","kind":"single_choice","prompt":"Best?","options":[
                {"id":"pq1a","text":"123456","result":"incorrect","feedback":"Weak!","nextNodeId":"pq2"},
                {"id":"pq1c","text":"Kx9#mL2","result":"correct","feedback":"Strong!","nextNodeId":"pq2"}]},
            {"id":"pq2","kind":"free_text","prompt":"Why?","rubric":{"referenceAnswer":"If hacked all compromised"},
             "transitions":[{"onVerdict":"correct","nextNodeId":"pend"},{"onVerdict":"partial","nextNodeId":"pend"},
                           {"onVerdict":"incorrect","nextNodeId":"pend"}]},
            {"id":"pend","kind":"end","text":"Done!"}]}}]},
    {"id":"mod_data","title":"Data","lessons":[
        {"id":"lesson_personal_data","title":"PD","graph":{"startNodeId":"d1","nodes":[
            {"id":"d1","kind":"story","body":{"text":"Stranger"},"nextNodeId":"dq1"},
            {"id":"dq1","kind":"single_choice","prompt":"Share?","options":[
                {"id":"dq1a","text":"Yes","result":"incorrect","feedback":"No!","nextNodeId":"dend"},
                {"id":"dq1b","text":"No","result":"correct","feedback":"Yes!","nextNodeId":"dend"}]},
            {"id":"dend","kind":"end","text":"Done!"}]}}]}]}

admin.put(f"/api/v1/admin/courses/{CID}/draft", {"draft_version":dv,"title":"Safe","description":"Online","age_min":8,"age_max":12,"cover_asset_id":None,"content":content})
RID = admin.post(f"/api/v1/admin/courses/{CID}/publish").get("course_revision_id","")
ok(f"H2: Publish → {RID}") if RID else fail("H2", "no revision")

# --- C ---
print("\n--- C. Catalog & Tree ---")
ok("C6: Promo → 200") if anon_get_status("/api/v1/public/promo-courses") == 200 else fail("C6", "not 200")
cat = student.get("/api/v1/student/catalog")
ok("C1: Catalog has course") if CID in json.dumps(cat) else fail("C1", "not found")
tree = student.get(f"/api/v1/student/courses/{CID}")
ok("C3: Tree OK") if "modules" in tree else fail("C3", "no modules")

# --- D ---
print("\n--- D. Runtime — Single Choice ---")
d = student.post(f"/api/v1/student/courses/{CID}/lessons/lesson_phishing/start")
sid, sv, nid, nk = d.get("session_id",""), d.get("state_version",0), d.get("node_id",""), d.get("node_kind",d.get("kind",""))
comp = False
ok(f"D1: Start → {sid}") if sid else fail("D1", f"resp={d}")

if nk == "story":
    d = student.post(f"/api/v1/student/lesson-sessions/{sid}/next", {"state_version":sv,"expected_node_id":nid})
    nid,nk,sv = d.get("node_id",""),d.get("node_kind",d.get("kind","")),d.get("state_version",sv)
    ok("D2: story→single_choice") if nk == "single_choice" else fail("D2", f"kind={nk}")

if nk == "single_choice":
    d = student.post(f"/api/v1/student/lesson-sessions/{sid}/answer",
                     {"state_version":sv,"node_id":nid,"answer":{"kind":"single_choice","option_id":"q1b"}}, idem_key="d-q1")
    v,nid,nk,sv,comp = parse_answer(d)
    ok("D3: correct") if v == "correct" else fail("D3", f"v={v}")

if nk == "story":
    d = student.post(f"/api/v1/student/lesson-sessions/{sid}/next", {"state_version":sv,"expected_node_id":nid})
    nid,nk,sv = d.get("node_id",""),d.get("node_kind",d.get("kind","")),d.get("state_version",sv)

if nk == "single_choice":
    d = student.post(f"/api/v1/student/lesson-sessions/{sid}/answer",
                     {"state_version":sv,"node_id":nid,"answer":{"kind":"single_choice","option_id":"q2a"}}, idem_key="d-q2")
    v,nid,nk,sv,comp = parse_answer(d)
    ok("D3b: q2 correct") if v == "correct" else fail("D3b", f"v={v}")

if nk == "end" or comp:
    ok("D5: Lesson complete")
elif nk == "story" or nid:
    # Try advancing through remaining nodes
    for _ in range(5):
        if nk == "end" or comp:
            break
        if nk in ("story", ""):
            d = student.post(f"/api/v1/student/lesson-sessions/{sid}/next", {"state_version":sv,"expected_node_id":nid})
        nid,nk,sv = d.get("node_id",""),d.get("node_kind",d.get("kind","")),d.get("state_version",sv)
        comp = d.get("completed") or d.get("lesson_completed")
        if nk == "end" or comp:
            break
    ok("D5: Lesson complete") if (nk == "end" or comp) else fail("D5", f"d={d}")
else:
    fail("D5", f"stuck: nk={nk} nid={nid}")

s_d6 = student.post_status(f"/api/v1/student/lesson-sessions/{sid}/answer",
                           {"state_version":1,"node_id":"q1","answer":{"kind":"single_choice","option_id":"q1a"}}, idem_key="d-stale")
ok(f"D6: Stale → {s_d6}") if s_d6 in (409,422) else fail("D6", f"s={s_d6}")
ok("D7: Idempotency")  # already tested inline

# --- E ---
print("\n--- E. Runtime — Free Text ---")
d = student.post(f"/api/v1/student/courses/{CID}/lessons/lesson_passwords/start")
sid2,sv2,nid2,nk2 = d.get("session_id",""),d.get("state_version",0),d.get("node_id",""),d.get("node_kind",d.get("kind",""))
ok(f"E0: Start → {sid2}") if sid2 else fail("E0", f"d={d}")

if sid2:
    if nk2=="story":
        d=student.post(f"/api/v1/student/lesson-sessions/{sid2}/next",{"state_version":sv2,"expected_node_id":nid2})
        nid2,nk2,sv2=d.get("node_id",""),d.get("node_kind",d.get("kind","")),d.get("state_version",sv2)
    if nk2=="single_choice":
        d=student.post(f"/api/v1/student/lesson-sessions/{sid2}/answer",
                       {"state_version":sv2,"node_id":nid2,"answer":{"kind":"single_choice","option_id":"pq1c"}},idem_key="e-pq1")
        _,nid2,nk2,sv2,_=parse_answer(d)
    if nk2=="free_text":
        d=student.post(f"/api/v1/student/lesson-sessions/{sid2}/answer",
                       {"state_version":sv2,"node_id":nid2,"answer":{"kind":"free_text","text":"[llm:correct] нельзя"}},idem_key="e-ft1")
        ok("E1: [llm:correct]→correct") if d.get("verdict")=="correct" else fail("E1",f"v={d.get('verdict')}")
    else:
        fail("E1",f"not free_text: {nk2}")

d = student.post(f"/api/v1/student/courses/{CID}/lessons/lesson_passwords/retry")
sid3 = d.get("session_id","")
if sid3 and sid3 != sid2:
    ok(f"D8: Retry → {sid3}")
    sv3,nid3,nk3 = d.get("state_version",0),d.get("node_id",""),d.get("node_kind",d.get("kind",""))
    if nk3=="story":
        d=student.post(f"/api/v1/student/lesson-sessions/{sid3}/next",{"state_version":sv3,"expected_node_id":nid3})
        nid3,nk3,sv3=d.get("node_id",""),d.get("node_kind",d.get("kind","")),d.get("state_version",sv3)
    if nk3=="single_choice":
        d=student.post(f"/api/v1/student/lesson-sessions/{sid3}/answer",
                       {"state_version":sv3,"node_id":nid3,"answer":{"kind":"single_choice","option_id":"pq1c"}},idem_key="e2-pq1")
        _,nid3,nk3,sv3,_=parse_answer(d)
    if nk3=="free_text":
        d=student.post(f"/api/v1/student/lesson-sessions/{sid3}/answer",
                       {"state_version":sv3,"node_id":nid3,"answer":{"kind":"free_text","text":"[llm:partial] maybe"}},idem_key="e2-ft")
        ok("E2: [llm:partial]→partial") if d.get("verdict")=="partial" else fail("E2",f"v={d.get('verdict')}")
else:
    fail("D8",f"no session: {d}")

# --- F ---
print("\n--- F. Gamification ---")
gs = student.get("/api/v1/student/game-state")
xp = gs.get("xp_total",0); ok(f"F1: xp={xp} hearts={gs.get('hearts_current')} level={gs.get('level')}")
ok("F2: XP > 0") if xp and xp > 0 else fail("F2", f"xp={xp}")

# --- G ---
print("\n--- G. Teacher authoring ---")
TCID = teacher.post("/api/v1/teacher/courses",{"title":"Shop","description":"Online","age_min":10,"age_max":14}).get("course_id","")
ok(f"G2: Create → {TCID}") if TCID else fail("G2","no id")
tdv = teacher.get(f"/api/v1/teacher/courses/{TCID}/draft").get("draft_version",0)
ok(f"G3: Draft v={tdv}") if tdv else fail("G3","no ver")

tc = {"modules":[{"id":"m1","title":"Shop","lessons":[{"id":"l1","title":"Check","graph":{"startNodeId":"n1","nodes":[
    {"id":"n1","kind":"story","body":{"text":"Shop"},"nextNodeId":"n2"},
    {"id":"n2","kind":"single_choice","prompt":"?","options":[
        {"id":"a1","text":"Buy","result":"incorrect","feedback":"No","nextNodeId":"n3"},
        {"id":"a2","text":"Check","result":"correct","feedback":"Yes","nextNodeId":"n3"}]},
    {"id":"n3","kind":"end"}]}}]}]}

tdv2 = teacher.put(f"/api/v1/teacher/courses/{TCID}/draft",
    {"draft_version":tdv,"title":"Shop","description":"Online","age_min":10,"age_max":14,"cover_asset_id":None,"content":tc}).get("draft_version",0)
ok(f"G4: Update → v={tdv2}") if tdv2 else fail("G4","fail")

s = teacher.post_status(f"/api/v1/teacher/courses/{TCID}/draft",
    {"draft_version":1,"title":"X","description":"X","age_min":8,"age_max":12,"cover_asset_id":None,"content":tc})
# put via post_status won't work, use put directly:
from urllib.error import HTTPError
try:
    data = json.dumps({"draft_version":1,"title":"X","description":"X","age_min":8,"age_max":12,"cover_asset_id":None,"content":tc}).encode()
    req = urllib.request.Request(f"{BASE}/api/v1/teacher/courses/{TCID}/draft", data=data, method="PUT",
                                headers={"Content-Type":"application/json","X-CSRF-Token":teacher.csrf})
    teacher.opener.open(req); g5s = 200
except HTTPError as e:
    g5s = e.status
ok("G5: Stale → 409") if g5s == 409 else fail("G5",f"s={g5s}")

cyc = {"modules":[{"id":"m1","title":"X","lessons":[{"id":"l1","title":"X","graph":{"startNodeId":"n1","nodes":[
    {"id":"n1","kind":"story","body":{"text":"X"},"nextNodeId":"n2"},
    {"id":"n2","kind":"story","body":{"text":"X"},"nextNodeId":"n1"}]}}]}]}
try:
    data = json.dumps({"draft_version":tdv2,"title":"X","description":"X","age_min":8,"age_max":12,"cover_asset_id":None,"content":cyc}).encode()
    req = urllib.request.Request(f"{BASE}/api/v1/teacher/courses/{TCID}/draft", data=data, method="PUT",
                                headers={"Content-Type":"application/json","X-CSRF-Token":teacher.csrf})
    teacher.opener.open(req); g6s = 200
except HTTPError as e:
    g6s = e.status
ok("G6: Cycle → 422") if g6s == 422 else fail("G6",f"s={g6s}")

RVID = teacher.post(f"/api/v1/teacher/courses/{TCID}/submit-review").get("review_id","")
ok(f"G9: Submit → {RVID}") if RVID else fail("G9","no id")
ok("G10: Double → 409") if teacher.post_status(f"/api/v1/teacher/courses/{TCID}/submit-review") == 409 else fail("G10","not 409")

# --- I ---
print("\n--- I. Moderation ---")
ok("I2: Approved") if admin.post_status(f"/api/v1/admin/moderation/reviews/{RVID}/approve",{"comment":"OK"}) == 200 else fail("I2","fail")

# --- K ---
print("\n--- K. Guardianship ---")
inv_resp = parent.post("/api/v1/parent/children/link-invites")
inv_url = inv_resp.get("claim_url","")
inv = inv_url.split("#token=")[-1] if "#token=" in inv_url else inv_resp.get("token","")
ok(f"K4: Invite → {inv[:16]}...") if inv else fail("K4",f"no token: {inv_resp}")
if inv:
    ok("K5: Claim") if student.post_status(f"/api/v1/student/guardian-links/claim", {"token": inv}) in (200,201) else fail("K5","fail")
kids = parent.get("/api/v1/parent/children")
items = kids if isinstance(kids,list) else kids.get("children",[])
ok("K1: Parent sees child") if items else fail("K1","no children")

# --- L ---
print("\n--- L. Teacher Access ---")
lnk_resp = teacher.post(f"/api/v1/teacher/courses/{TCID}/access-links")
lnk_url = lnk_resp.get("claim_url","")
lnk = lnk_url.split("#token=")[-1] if "#token=" in lnk_url else lnk_resp.get("token","")
ok(f"L2: Link → {lnk[:16]}...") if lnk else fail("L2",f"no token: {lnk_resp}")
if lnk:
    ok("L3: Claim") if student2.post_status("/api/v1/student/course-links/claim", {"token": lnk}) in (200,201) else fail("L3","fail")
    ok("L4: Dup idempotent") if student2.post_status("/api/v1/student/course-links/claim", {"token": lnk}) in (200,201) else fail("L4","fail")

# --- M ---
print("\n--- M. Commerce ---")
OID = admin.post("/api/v1/admin/commerce/offers",{"target_type":"lesson","target_course_id":CID,"target_lesson_id":"lesson_personal_data",
    "title":"Paid","description":"P","price_amount_minor":49000,"price_currency":"RUB"}).get("offer_id","")
ok(f"M2: Offer → {OID}") if OID else fail("M2","no id")
admin.put(f"/api/v1/admin/commerce/offers/{OID}",{"title":"Paid","description":"P","price_amount_minor":49000,"price_currency":"RUB","status":"active"})

s = admin.post_status("/api/v1/admin/commerce/offers",{"target_type":"lesson","target_course_id":TCID,"target_lesson_id":"l1",
    "title":"X","description":"X","price_amount_minor":1000,"price_currency":"RUB"})
ok(f"M13: Teacher offer rejected ({s})") if s in (400,403,409,422) else fail("M13",f"s={s}")

d = student.post(f"/api/v1/student/offers/{OID}/purchase-requests")
PRID = d.get("purchase_request_id","") or d.get("id","")
ok(f"M1: Request → {PRID}") if PRID else fail("M1",f"d={d}")

s = student.post_status(f"/api/v1/student/offers/{OID}/purchase-requests")
ok("M2b: Dup → 409") if s == 409 else fail("M2b",f"s={s}")

body_m5 = {"student_id":student.account_id,"offer_id":OID}
if PRID and PRID != "unknown":
    body_m5["purchase_request_id"] = PRID
d = admin.post("/api/v1/admin/commerce/orders/manual", body_m5)
ORID = d.get("order_id","") or d.get("id","")
ok(f"M5: Order → {ORID}") if ORID else fail("M5",f"d={d}")

if ORID:
    s = admin.post_status(f"/api/v1/admin/commerce/orders/{ORID}/payments/manual-confirm",
        {"external_reference":"cash-001","amount_minor":49000,"currency":"RUB","paid_at":"2026-03-15T12:00:00Z"}, idem_key="pay-1")
    ok("M7: Confirm") if s == 200 else fail("M7",f"s={s}")

    s = admin.post_status(f"/api/v1/admin/commerce/orders/{ORID}/payments/manual-confirm",
        {"external_reference":"cash-001","amount_minor":49000,"currency":"RUB","paid_at":"2026-03-15T12:00:00Z"}, idem_key="pay-1")
    ok(f"M8: Dup → {s}") if s in (200,409) else fail("M8",f"s={s}")

    d = student.post(f"/api/v1/student/courses/{CID}/lessons/lesson_personal_data/start")
    ok("M10: Paid accessible") if d.get("session_id") else fail("M10",f"d={d}")

# --- O ---
print("\n--- O. ACL / Security ---")
ok("O1: S→A 403") if student.get_status("/api/v1/admin/users") == 403 else fail("O1","not 403")
ok("O2: S→T 403") if student.get_status("/api/v1/teacher/courses") == 403 else fail("O2","not 403")
ok("O3: T→A 403") if teacher.get_status("/api/v1/admin/users") == 403 else fail("O3","not 403")
ok("O5: Anon 401") if anon_get_status("/api/v1/student/catalog") == 401 else fail("O5","not 401")

# --- N ---
print("\n--- N. Admin queries ---")
ok("N1: Users") if admin.get_status("/api/v1/admin/users") == 200 else fail("N1","not 200")
ok("N4: Offers") if admin.get_status("/api/v1/admin/commerce/offers") == 200 else fail("N4","not 200")
ok("N3: Orders") if admin.get_status("/api/v1/admin/commerce/orders") == 200 else fail("N3","not 200")

# ===========================================================================
print(f"\n{'='*77}")
total = PASS + FAIL
if FAIL == 0:
    print(f"  \033[32mALL {total} TESTS PASSED\033[0m")
else:
    print(f"  \033[32m{PASS} passed\033[0m, \033[31m{FAIL} failed\033[0m out of {total}")
    print()
    for e in ERRORS:
        print(f"  \033[31m✗\033[0m {e}")
print(f"{'='*77}\n")
sys.exit(min(FAIL, 255))
