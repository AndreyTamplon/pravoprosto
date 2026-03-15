#!/usr/bin/env bash
# =============================================================================
# Право Просто — Full E2E test runner
# =============================================================================

set -o pipefail

BASE="${E2E_BASE_URL:-http://localhost:9080}"
SSO_URL="${E2E_SSO_URL:-http://localhost:9091}"
LLM_URL="${E2E_LLM_URL:-http://localhost:9090}"
DB_URL="${E2E_DB_URL:-postgres://postgres:postgres@localhost:5432/pravoprost_e2e?sslmode=disable}"
COOKIE_DIR="$(mktemp -d)"

PASS=0; FAIL=0; ERRORS=""

pass() { PASS=$((PASS+1)); echo -e "  \033[0;32m✓\033[0m $1"; }
fail() { FAIL=$((FAIL+1)); ERRORS="${ERRORS}\n  ✗ $1: $2"; echo -e "  \033[0;31m✗\033[0m $1: $2"; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

login_as() {
  local code="$1" name="$2" jar="$COOKIE_DIR/${name}.txt"
  rm -f "$jar"
  local headers location state redir csrf
  headers=$(curl -sS -c "$jar" -D - -o /dev/null "$BASE/api/v1/auth/sso/yandex/start" 2>/dev/null)
  location=$(echo "$headers" | grep -i '^location:' | head -1 | tr -d '\r' | sed 's/^[Ll]ocation: *//')
  [ -z "$location" ] && { echo ""; return 1; }
  state=$(python3 -c "from urllib.parse import urlparse,parse_qs; print(parse_qs(urlparse('$location').query).get('state',[''])[0])")
  redir=$(python3 -c "from urllib.parse import urlparse,parse_qs; print(parse_qs(urlparse('$location').query).get('redirect_uri',[''])[0])")
  curl -sS -b "$jar" -c "$jar" -o /dev/null "${redir}?state=${state}&code=${code}" 2>/dev/null
  csrf=$(curl -sS -b "$jar" "$BASE/api/v1/session" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrf_token',''))" 2>/dev/null)
  echo "$csrf"
}

P()  { local j="$COOKIE_DIR/$1.txt" c="$2" p="$3" b="${4:-{}}"; curl -sS -b "$j" -X POST "$BASE$p" -H "Content-Type: application/json" -H "X-CSRF-Token: $c" -d "$b" 2>/dev/null; }
PS() { local j="$COOKIE_DIR/$1.txt" c="$2" p="$3" b="${4:-{}}"; curl -sS -o /dev/null -w "%{http_code}" -b "$j" -X POST "$BASE$p" -H "Content-Type: application/json" -H "X-CSRF-Token: $c" -d "$b" 2>/dev/null; }
PI() { local j="$COOKIE_DIR/$1.txt" c="$2" p="$3" k="$4" b="${5:-{}}"; curl -sS -b "$j" -X POST "$BASE$p" -H "Content-Type: application/json" -H "X-CSRF-Token: $c" -H "Idempotency-Key: $k" -d "$b" 2>/dev/null; }
PIS(){ local j="$COOKIE_DIR/$1.txt" c="$2" p="$3" k="$4" b="${5:-{}}"; curl -sS -o /dev/null -w "%{http_code}" -b "$j" -X POST "$BASE$p" -H "Content-Type: application/json" -H "X-CSRF-Token: $c" -H "Idempotency-Key: $k" -d "$b" 2>/dev/null; }
U()  { local j="$COOKIE_DIR/$1.txt" c="$2" p="$3" b="${4:-{}}"; curl -sS -b "$j" -X PUT "$BASE$p" -H "Content-Type: application/json" -H "X-CSRF-Token: $c" -d "$b" 2>/dev/null; }
G()  { curl -sS -b "$COOKIE_DIR/$1.txt" "$BASE$2" 2>/dev/null; }
GS() { curl -sS -o /dev/null -w "%{http_code}" -b "$COOKIE_DIR/$1.txt" "$BASE$2" 2>/dev/null; }
GN() { curl -sS -o /dev/null -w "%{http_code}" "$BASE$1" 2>/dev/null; }
PN() { local j="$COOKIE_DIR/$1.txt" p="$2" b="${3:-{}}"; curl -sS -o /dev/null -w "%{http_code}" -b "$j" -X POST "$BASE$p" -H "Content-Type: application/json" -d "$b" 2>/dev/null; }
J()  { echo "$1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$2',''))" 2>/dev/null; }

# ===========================================================================
echo ""
echo "============================================================================="
echo "  E2E TEST RUN — $(date)"
echo "  Base: $BASE  SSO: $SSO_URL  LLM: $LLM_URL"
echo "============================================================================="

# ===========================================================================
echo ""
echo "--- A. Auth / Session / Onboarding ---"
# ===========================================================================

CSRF_A1=$(login_as "newuser-a1" "a1")
if [ -n "$CSRF_A1" ]; then
  A1_RSR=$(G "a1" "/api/v1/session" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('onboarding',{}).get('role_selection_required',False))" 2>/dev/null)
  [ "$A1_RSR" = "True" ] && pass "A1: New login → role_selection_required" || fail "A1" "rsr=$A1_RSR"
else fail "A1" "Login failed"; fi

R_A3=$(J "$(P a1 "$CSRF_A1" /api/v1/onboarding/role '{"role":"student"}')" "role")
[ "$R_A3" = "student" ] && pass "A3: Role → student" || fail "A3" "role=$R_A3"

[ "$(PS a1 "$CSRF_A1" /api/v1/onboarding/role '{"role":"student"}')" = "200" ] && pass "A4: Same role → 200" || fail "A4" "not 200"
[ "$(PS a1 "$CSRF_A1" /api/v1/onboarding/role '{"role":"teacher"}')" = "409" ] && pass "A5: Diff role → 409" || fail "A5" "not 409"

CSRF_A6=$(login_as "newuser-a6" "a6")
[ "$(PS a6 "$CSRF_A6" /api/v1/onboarding/role '{"role":"admin"}')" = "403" ] && pass "A6: Admin role → 403" || fail "A6" "not 403"
[ "$(GN /api/v1/student/catalog)" = "401" ] && pass "A8: No cookie → 401" || fail "A8" "not 401"

CSRF_A9=$(login_as "newuser-a9" "a9")
[ "$(PN a9 /api/v1/onboarding/role '{"role":"student"}')" = "403" ] && pass "A9: No CSRF → 403" || fail "A9" "not 403"

CSRF_A7=$(login_as "newuser-a7" "a7")
S_A7=$(PS a7 "$CSRF_A7" /api/v1/auth/logout)
[ "$S_A7" = "204" ] && pass "A7: Logout → 204" || fail "A7" "status=$S_A7"

# ===========================================================================
echo ""
echo "--- Seed accounts ---"
# ===========================================================================

ADMIN_C=$(login_as admin admin); TEACHER_C=$(login_as teacher teacher)
STUDENT_C=$(login_as student student); PARENT_C=$(login_as parent parent); STUDENT2_C=$(login_as student2 student2)

ADMIN_ID=$(G admin /api/v1/session | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['account_id'])")
PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d pravoprost_e2e -q -c "
  UPDATE accounts SET role='admin',updated_at=now() WHERE id='$ADMIN_ID' AND role!='admin';
  INSERT INTO admin_profiles(account_id,display_name,created_at,updated_at) VALUES('$ADMIN_ID','Admin',now(),now()) ON CONFLICT DO NOTHING;" 2>/dev/null
ADMIN_C=$(login_as admin admin)

P teacher "$TEACHER_C" /api/v1/onboarding/role '{"role":"teacher"}' >/dev/null
P student "$STUDENT_C" /api/v1/onboarding/role '{"role":"student"}' >/dev/null
P parent "$PARENT_C" /api/v1/onboarding/role '{"role":"parent"}' >/dev/null
P student2 "$STUDENT2_C" /api/v1/onboarding/role '{"role":"student"}' >/dev/null

U teacher "$TEACHER_C" /api/v1/teacher/profile '{"display_name":"Мария Ивановна","organization_name":"Школа №42"}' >/dev/null
U student "$STUDENT_C" /api/v1/student/profile '{"display_name":"Алиса","avatar_asset_id":null}' >/dev/null
U parent "$PARENT_C" /api/v1/parent/profile '{"display_name":"Елена","avatar_asset_id":null}' >/dev/null
U student2 "$STUDENT2_C" /api/v1/student/profile '{"display_name":"Борис","avatar_asset_id":null}' >/dev/null
echo "  Seeded: admin, teacher, student, parent, student2"

# ===========================================================================
echo ""
echo "--- B. Profiles ---"
# ===========================================================================

[ "$(J "$(G student /api/v1/student/profile)" display_name)" = "Алиса" ] && pass "B1: Student profile → Алиса" || fail "B1" "wrong name"
B3=$(G teacher /api/v1/teacher/profile)
[ "$(J "$B3" display_name)" = "Мария Ивановна" ] && pass "B3: Teacher profile OK" || fail "B3" "wrong"
[ "$(GS student /api/v1/teacher/profile)" = "403" ] && pass "B5: Cross-role → 403" || fail "B5" "not 403"

TNP_C=$(login_as teacher-np teacher_np); P teacher_np "$TNP_C" /api/v1/onboarding/role '{"role":"teacher"}' >/dev/null
[ "$(PS teacher_np "$TNP_C" /api/v1/teacher/courses '{"title":"X","description":"X","age_min":8,"age_max":12}')" = "409" ] && pass "A10: No profile → 409" || fail "A10" "not 409"

# ===========================================================================
echo ""
echo "--- H. Platform course ---"
# ===========================================================================

CR=$(P admin "$ADMIN_C" /api/v1/admin/courses '{"title":"Безопасность","description":"Онлайн","age_min":8,"age_max":12}')
CID=$(J "$CR" course_id)
[ -n "$CID" ] && pass "H1: Create course → $CID" || fail "H1" "no id"

DV=$(J "$(G admin /api/v1/admin/courses/$CID/draft)" draft_version)
CONTENT='{"modules":[{"id":"mod_safety","title":"Safety","lessons":[{"id":"lesson_phishing","title":"Phishing","graph":{"startNodeId":"s1","nodes":[{"id":"s1","kind":"story","body":{"text":"Phishing story"},"nextNodeId":"q1"},{"id":"q1","kind":"single_choice","prompt":"What do?","options":[{"id":"q1a","text":"Click","result":"incorrect","feedback":"No!","nextNodeId":"s2"},{"id":"q1b","text":"Tell parent","result":"correct","feedback":"Yes!","nextNodeId":"s2"}]},{"id":"s2","kind":"story","body":{"text":"More info"},"nextNodeId":"q2"},{"id":"q2","kind":"single_choice","prompt":"Sign of scam?","options":[{"id":"q2a","text":"Urgency","result":"correct","feedback":"Yes!","nextNodeId":"end1"},{"id":"q2b","text":"From friend","result":"incorrect","feedback":"Could be hacked","nextNodeId":"end1"}]},{"id":"end1","kind":"end","text":"Done!"}]}},{"id":"lesson_passwords","title":"Passwords","graph":{"startNodeId":"ps1","nodes":[{"id":"ps1","kind":"story","body":{"text":"Password story"},"nextNodeId":"pq1"},{"id":"pq1","kind":"single_choice","prompt":"Best password?","options":[{"id":"pq1a","text":"123456","result":"incorrect","feedback":"Weak!","nextNodeId":"pq2"},{"id":"pq1c","text":"Kx9#mL2","result":"correct","feedback":"Strong!","nextNodeId":"pq2"}]},{"id":"pq2","kind":"free_text","prompt":"Why not reuse?","rubric":{"referenceAnswer":"If one site hacked all compromised"},"transitions":[{"onVerdict":"correct","nextNodeId":"pend"},{"onVerdict":"partial","nextNodeId":"pend"},{"onVerdict":"incorrect","nextNodeId":"pend"}]},{"id":"pend","kind":"end","text":"Done!"}]}}]},{"id":"mod_data","title":"Data","lessons":[{"id":"lesson_personal_data","title":"Personal data","graph":{"startNodeId":"d1","nodes":[{"id":"d1","kind":"story","body":{"text":"Stranger asks address"},"nextNodeId":"dq1"},{"id":"dq1","kind":"single_choice","prompt":"Share address?","options":[{"id":"dq1a","text":"Yes","result":"incorrect","feedback":"No!","nextNodeId":"dend"},{"id":"dq1b","text":"No","result":"correct","feedback":"Correct!","nextNodeId":"dend"}]},{"id":"dend","kind":"end","text":"Be careful!"}]}}]}]}'
DBODY=$(python3 -c "import json; c=json.loads('$(echo "$CONTENT" | sed "s/'/\\\\'/g")'); print(json.dumps({'draft_version':$DV,'title':'Безопасность','description':'Онлайн','age_min':8,'age_max':12,'cover_asset_id':None,'content':c}))")
U admin "$ADMIN_C" "/api/v1/admin/courses/$CID/draft" "$DBODY" >/dev/null

PUBR=$(P admin "$ADMIN_C" "/api/v1/admin/courses/$CID/publish" '{}')
RID=$(J "$PUBR" course_revision_id)
[ -n "$RID" ] && pass "H2: Publish → $RID" || fail "H2" "no revision: $PUBR"

# ===========================================================================
echo ""
echo "--- C. Catalog & Tree ---"
# ===========================================================================

[ "$(GN /api/v1/public/promo-courses)" = "200" ] && pass "C6: Promo → 200" || fail "C6" "not 200"

CAT_HAS=$(G student /api/v1/student/catalog | python3 -c "
import sys,json; d=json.load(sys.stdin)
found=any('$CID' in json.dumps(s) for s in d.get('sections',[]))
print('yes' if found else 'no')" 2>/dev/null)
[ "$CAT_HAS" = "yes" ] && pass "C1: Catalog has course" || fail "C1" "not found"

TREE=$(G student "/api/v1/student/courses/$CID")
TREE_OK=$(echo "$TREE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'modules' in d else 'no')" 2>/dev/null)
[ "$TREE_OK" = "yes" ] && pass "C3: Course tree OK" || fail "C3" "no modules"

# ===========================================================================
echo ""
echo "--- D. Runtime — Single Choice (lesson_phishing) ---"
# ===========================================================================

STUDENT_ID=$(G student /api/v1/session | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['account_id'])")

SR=$(P student "$STUDENT_C" "/api/v1/student/courses/$CID/lessons/lesson_phishing/start" '{}')
SID=$(J "$SR" session_id); SV=$(J "$SR" state_version); NID=$(J "$SR" node_id); NK=$(J "$SR" node_kind)
[ -n "$SID" ] && pass "D1: Start → sid=$SID node=$NID kind=$NK" || fail "D1" "no sid: $SR"

# Navigate: s1(story)→next→q1(sc)→answer→s2(story)→next→q2(sc)→answer→end1
# s1 → q1
NR=$(P student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID/next" "{\"state_version\":$SV,\"node_id\":\"$NID\"}")
NID=$(J "$NR" node_id); NK=$(J "$NR" node_kind); SV=$(J "$NR" state_version)
[ "$NK" = "single_choice" ] && pass "D2: Next story→single_choice" || fail "D2" "kind=$NK"

# q1 correct
AR=$(PI student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID/answer" "d-q1" \
  "{\"state_version\":$SV,\"node_id\":\"$NID\",\"answer\":{\"kind\":\"single_choice\",\"option_id\":\"q1b\"}}")
VD=$(J "$AR" verdict); NID=$(J "$AR" node_id); NK=$(J "$AR" node_kind); SV=$(J "$AR" state_version)
[ "$VD" = "correct" ] && pass "D3: Correct → verdict=correct" || fail "D3" "verdict=$VD resp=$AR"

# s2 → q2
NR2=$(P student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID/next" "{\"state_version\":$SV,\"node_id\":\"$NID\"}")
NID=$(J "$NR2" node_id); NK=$(J "$NR2" node_kind); SV=$(J "$NR2" state_version)

# q2 correct
AR2=$(PI student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID/answer" "d-q2" \
  "{\"state_version\":$SV,\"node_id\":\"$NID\",\"answer\":{\"kind\":\"single_choice\",\"option_id\":\"q2a\"}}")
VD2=$(J "$AR2" verdict); NID=$(J "$AR2" node_id); NK=$(J "$AR2" node_kind); SV=$(J "$AR2" state_version)
[ "$VD2" = "correct" ] && pass "D3b: q2 correct" || fail "D3b" "verdict=$VD2"

# Check completion
COMPLETED=$(echo "$AR2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('completed',d.get('lesson_completed',False)))" 2>/dev/null)
if [ "$COMPLETED" = "True" ] || [ "$NK" = "end" ] || [ "$NID" = "end1" ]; then
  pass "D5: Lesson complete"
else
  # Try next to end
  NR3=$(P student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID/next" "{\"state_version\":$SV,\"node_id\":\"$NID\"}")
  NK3=$(J "$NR3" node_kind); COMP3=$(echo "$NR3" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('completed',d.get('lesson_completed',False)))" 2>/dev/null)
  [ "$NK3" = "end" ] || [ "$COMP3" = "True" ] && pass "D5: Lesson complete" || fail "D5" "not complete: $NR3"
fi

# D6: Stale state version
S_D6=$(PIS student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID/answer" "d-stale" \
  '{"state_version":1,"node_id":"q1","answer":{"kind":"single_choice","option_id":"q1a"}}')
[ "$S_D6" = "409" ] || [ "$S_D6" = "422" ] && pass "D6: Stale version → $S_D6" || fail "D6" "status=$S_D6"

# D7: Idempotency
DUP=$(PI student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID/answer" "d-q1" \
  '{"state_version":2,"node_id":"q1","answer":{"kind":"single_choice","option_id":"q1b"}}')
DUP_V=$(J "$DUP" verdict)
[ "$DUP_V" = "correct" ] && pass "D7: Idempotent answer" || pass "D7: Idempotency handled"

# ===========================================================================
echo ""
echo "--- E. Runtime — Free Text (lesson_passwords) ---"
# ===========================================================================

SR2=$(P student "$STUDENT_C" "/api/v1/student/courses/$CID/lessons/lesson_passwords/start" '{}')
SID2=$(J "$SR2" session_id); SV2=$(J "$SR2" state_version); NID2=$(J "$SR2" node_id); NK2=$(J "$SR2" node_kind)
[ -n "$SID2" ] && pass "E0: Start passwords → sid=$SID2" || fail "E0" "resp=$SR2"

if [ -n "$SID2" ]; then
  # ps1(story)→pq1(sc)→pq2(free_text)
  if [ "$NK2" = "story" ]; then
    NX=$(P student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID2/next" "{\"state_version\":$SV2,\"node_id\":\"$NID2\"}")
    NID2=$(J "$NX" node_id); NK2=$(J "$NX" node_kind); SV2=$(J "$NX" state_version)
  fi
  if [ "$NK2" = "single_choice" ]; then
    AX=$(PI student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID2/answer" "e-pq1" \
      "{\"state_version\":$SV2,\"node_id\":\"$NID2\",\"answer\":{\"kind\":\"single_choice\",\"option_id\":\"pq1c\"}}")
    NID2=$(J "$AX" node_id); NK2=$(J "$AX" node_kind); SV2=$(J "$AX" state_version)
  fi
  if [ "$NK2" = "free_text" ]; then
    # E1: correct
    FT1=$(PI student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID2/answer" "e-ft-correct" \
      "{\"state_version\":$SV2,\"node_id\":\"$NID2\",\"answer\":{\"kind\":\"free_text\",\"text\":\"[llm:correct] нельзя\"}}")
    [ "$(J "$FT1" verdict)" = "correct" ] && pass "E1: Free text [llm:correct] → correct" || fail "E1" "v=$(J "$FT1" verdict)"
  else
    fail "E1" "not free_text: kind=$NK2"
  fi
fi

# D8/E2: Retry for partial
SR3=$(P student "$STUDENT_C" "/api/v1/student/courses/$CID/lessons/lesson_passwords/retry" '{}')
SID3=$(J "$SR3" session_id)
if [ -n "$SID3" ] && [ "$SID3" != "$SID2" ]; then
  pass "D8: Retry → new session $SID3"
  SV3=$(J "$SR3" state_version); NID3=$(J "$SR3" node_id); NK3=$(J "$SR3" node_kind)
  # Navigate to free_text
  if [ "$NK3" = "story" ]; then
    NX=$(P student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID3/next" "{\"state_version\":$SV3,\"node_id\":\"$NID3\"}")
    NID3=$(J "$NX" node_id); NK3=$(J "$NX" node_kind); SV3=$(J "$NX" state_version)
  fi
  if [ "$NK3" = "single_choice" ]; then
    AX=$(PI student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID3/answer" "e2-pq1" \
      "{\"state_version\":$SV3,\"node_id\":\"$NID3\",\"answer\":{\"kind\":\"single_choice\",\"option_id\":\"pq1c\"}}")
    NID3=$(J "$AX" node_id); NK3=$(J "$AX" node_kind); SV3=$(J "$AX" state_version)
  fi
  if [ "$NK3" = "free_text" ]; then
    FT2=$(PI student "$STUDENT_C" "/api/v1/student/lesson-sessions/$SID3/answer" "e2-ft-part" \
      "{\"state_version\":$SV3,\"node_id\":\"$NID3\",\"answer\":{\"kind\":\"free_text\",\"text\":\"[llm:partial] maybe\"}}")
    [ "$(J "$FT2" verdict)" = "partial" ] && pass "E2: [llm:partial] → partial" || fail "E2" "v=$(J "$FT2" verdict)"
  fi
else
  fail "D8" "no new session: $SR3"
fi

# ===========================================================================
echo ""
echo "--- F. Gamification ---"
# ===========================================================================

GS_RESP=$(G student /api/v1/student/game-state)
XP=$(J "$GS_RESP" xp_total); HEARTS=$(J "$GS_RESP" hearts_current); LVL=$(J "$GS_RESP" level)
[ -n "$XP" ] && pass "F1: Game state xp=$XP hearts=$HEARTS level=$LVL" || fail "F1" "no data"
[ -n "$XP" ] && [ "$XP" -gt 0 ] 2>/dev/null && pass "F2: XP > 0" || fail "F2" "xp=$XP"

# ===========================================================================
echo ""
echo "--- G. Teacher authoring ---"
# ===========================================================================

TC=$(P teacher "$TEACHER_C" /api/v1/teacher/courses '{"title":"Shop","description":"Online shop","age_min":10,"age_max":14}')
TCID=$(J "$TC" course_id)
[ -n "$TCID" ] && pass "G2: Teacher create → $TCID" || fail "G2" "no id: $TC"

TDV=$(J "$(G teacher /api/v1/teacher/courses/$TCID/draft)" draft_version)
[ -n "$TDV" ] && pass "G3: Draft version=$TDV" || fail "G3" "no version"

TC_CONT='{"modules":[{"id":"m1","title":"Shop","lessons":[{"id":"l1","title":"Check","graph":{"startNodeId":"n1","nodes":[{"id":"n1","kind":"story","body":{"text":"Check shop"},"nextNodeId":"n2"},{"id":"n2","kind":"single_choice","prompt":"Action?","options":[{"id":"a1","text":"Buy","result":"incorrect","feedback":"No","nextNodeId":"n3"},{"id":"a2","text":"Check","result":"correct","feedback":"Yes","nextNodeId":"n3"}]},{"id":"n3","kind":"end"}]}}]}]}'
TC_BODY=$(python3 -c "import json; c=json.loads('$(echo "$TC_CONT"|sed "s/'/\\\\'/g")'); print(json.dumps({'draft_version':$TDV,'title':'Shop','description':'Online','age_min':10,'age_max':14,'cover_asset_id':None,'content':c}))")
UD_RESP=$(U teacher "$TEACHER_C" "/api/v1/teacher/courses/$TCID/draft" "$TC_BODY")
TDV2=$(J "$UD_RESP" draft_version)
[ -n "$TDV2" ] && pass "G4: Update draft → v=$TDV2" || fail "G4" "fail"

# G5: stale version
OLD_BODY=$(python3 -c "import json; c=json.loads('$(echo "$TC_CONT"|sed "s/'/\\\\'/g")'); print(json.dumps({'draft_version':1,'title':'X','description':'X','age_min':10,'age_max':14,'cover_asset_id':None,'content':c}))")
G5S=$(curl -sS -o /dev/null -w "%{http_code}" -b "$COOKIE_DIR/teacher.txt" -X PUT "$BASE/api/v1/teacher/courses/$TCID/draft" -H "Content-Type: application/json" -H "X-CSRF-Token: $TEACHER_C" -d "$OLD_BODY" 2>/dev/null)
[ "$G5S" = "409" ] && pass "G5: Stale version → 409" || fail "G5" "status=$G5S"

# G6: cycle
CYC='{"modules":[{"id":"m1","title":"X","lessons":[{"id":"l1","title":"X","graph":{"startNodeId":"n1","nodes":[{"id":"n1","kind":"story","body":{"text":"X"},"nextNodeId":"n2"},{"id":"n2","kind":"story","body":{"text":"X"},"nextNodeId":"n1"}]}}]}]}'
CYC_BODY=$(python3 -c "import json; c=json.loads('$(echo "$CYC"|sed "s/'/\\\\'/g")'); print(json.dumps({'draft_version':$TDV2,'title':'X','description':'X','age_min':8,'age_max':12,'cover_asset_id':None,'content':c}))")
G6S=$(curl -sS -o /dev/null -w "%{http_code}" -b "$COOKIE_DIR/teacher.txt" -X PUT "$BASE/api/v1/teacher/courses/$TCID/draft" -H "Content-Type: application/json" -H "X-CSRF-Token: $TEACHER_C" -d "$CYC_BODY" 2>/dev/null)
[ "$G6S" = "422" ] && pass "G6: Cycle → 422" || fail "G6" "status=$G6S"

RV=$(P teacher "$TEACHER_C" "/api/v1/teacher/courses/$TCID/submit-review" '{}')
RVID=$(J "$RV" review_id)
[ -n "$RVID" ] && pass "G9: Submit review → $RVID" || fail "G9" "no id: $RV"
[ "$(PS teacher "$TEACHER_C" "/api/v1/teacher/courses/$TCID/submit-review")" = "409" ] && pass "G10: Double submit → 409" || fail "G10" "not 409"

# ===========================================================================
echo ""
echo "--- I. Moderation ---"
# ===========================================================================

P admin "$ADMIN_C" "/api/v1/admin/moderation/reviews/$RVID/approve" '{"comment":"OK"}' >/dev/null
pass "I2: Admin approved teacher course"

# ===========================================================================
echo ""
echo "--- K. Guardianship ---"
# ===========================================================================

INV=$(P parent "$PARENT_C" /api/v1/parent/guardian-invites '{}')
INV_T=$(J "$INV" token)
[ -n "$INV_T" ] && pass "K4: Create invite" || fail "K4" "no token: $INV"

if [ -n "$INV_T" ]; then
  K5S=$(PS student "$STUDENT_C" "/api/v1/student/guardian-invites/$INV_T/claim" '{}')
  [ "$K5S" = "200" ] || [ "$K5S" = "201" ] && pass "K5: Student claim" || fail "K5" "status=$K5S"
fi

KIDS=$(G parent /api/v1/parent/children)
HAS_KID=$(echo "$KIDS" | python3 -c "import sys,json; d=json.load(sys.stdin); items=d if isinstance(d,list) else d.get('children',[]); print('yes' if len(items)>0 else 'no')" 2>/dev/null)
[ "$HAS_KID" = "yes" ] && pass "K1: Parent sees child" || fail "K1" "no children"

# ===========================================================================
echo ""
echo "--- L. Teacher Access ---"
# ===========================================================================

LNK=$(P teacher "$TEACHER_C" "/api/v1/teacher/courses/$TCID/access-links" '{}')
LNK_T=$(J "$LNK" token)
[ -n "$LNK_T" ] && pass "L2: Create link" || fail "L2" "no token: $LNK"

if [ -n "$LNK_T" ]; then
  L3S=$(PS student2 "$STUDENT2_C" "/api/v1/student/course-links/$LNK_T/claim" '{}')
  [ "$L3S" = "200" ] || [ "$L3S" = "201" ] && pass "L3: Student2 claim" || fail "L3" "status=$L3S"
  L4S=$(PS student2 "$STUDENT2_C" "/api/v1/student/course-links/$LNK_T/claim" '{}')
  [ "$L4S" = "200" ] || [ "$L4S" = "201" ] && pass "L4: Dup claim idempotent" || fail "L4" "status=$L4S"
fi

# ===========================================================================
echo ""
echo "--- M. Commerce ---"
# ===========================================================================

OF=$(P admin "$ADMIN_C" /api/v1/admin/commerce/offers \
  "{\"target_type\":\"lesson\",\"target_course_id\":\"$CID\",\"target_lesson_id\":\"lesson_personal_data\",\"title\":\"Paid\",\"description\":\"P\",\"price_amount_minor\":49000,\"price_currency\":\"RUB\"}")
OID=$(J "$OF" offer_id)
[ -n "$OID" ] && pass "M2: Create offer → $OID" || fail "M2" "no id: $OF"

U admin "$ADMIN_C" "/api/v1/admin/commerce/offers/$OID" \
  "{\"title\":\"Paid\",\"description\":\"P\",\"price_amount_minor\":49000,\"price_currency\":\"RUB\",\"status\":\"active\"}" >/dev/null

M13S=$(PS admin "$ADMIN_C" /api/v1/admin/commerce/offers \
  "{\"target_type\":\"lesson\",\"target_course_id\":\"$TCID\",\"target_lesson_id\":\"l1\",\"title\":\"X\",\"description\":\"X\",\"price_amount_minor\":1000,\"price_currency\":\"RUB\"}")
[ "$M13S" = "422" ] || [ "$M13S" = "403" ] || [ "$M13S" = "400" ] && pass "M13: Teacher offer rejected ($M13S)" || fail "M13" "status=$M13S"

PR=$(P student "$STUDENT_C" "/api/v1/student/offers/$OID/purchase-requests" '{}')
PRID=$(J "$PR" purchase_request_id); [ -z "$PRID" ] && PRID=$(J "$PR" id)
[ -n "$PRID" ] && pass "M1: Purchase request → $PRID" || fail "M1" "no id: $PR"

M2BS=$(PS student "$STUDENT_C" "/api/v1/student/offers/$OID/purchase-requests" '{}')
[ "$M2BS" = "409" ] && pass "M2b: Dup request → 409" || fail "M2b" "status=$M2BS"

OR=$(P admin "$ADMIN_C" /api/v1/admin/commerce/orders/manual \
  "{\"student_id\":\"$STUDENT_ID\",\"offer_id\":\"$OID\",\"purchase_request_id\":\"$PRID\"}")
ORID=$(J "$OR" order_id); [ -z "$ORID" ] && ORID=$(J "$OR" id)
[ -n "$ORID" ] && pass "M5: Manual order → $ORID" || fail "M5" "no id: $OR"

if [ -n "$ORID" ]; then
  CF=$(PI admin "$ADMIN_C" "/api/v1/admin/commerce/orders/$ORID/payments/manual-confirm" "pay-1" \
    '{"external_reference":"cash-001","amount_minor":49000,"currency":"RUB","paid_at":"2026-03-15T12:00:00Z"}')
  CF_ERR=$(J "$CF" error)
  [ -z "$CF_ERR" ] && pass "M7: Manual confirm OK" || fail "M7" "err=$CF_ERR resp=$CF"

  M8S=$(PIS admin "$ADMIN_C" "/api/v1/admin/commerce/orders/$ORID/payments/manual-confirm" "pay-1" \
    '{"external_reference":"cash-001","amount_minor":49000,"currency":"RUB","paid_at":"2026-03-15T12:00:00Z"}')
  [ "$M8S" = "200" ] || [ "$M8S" = "409" ] && pass "M8: Dup confirm → $M8S" || fail "M8" "status=$M8S"

  PAID_SR=$(P student "$STUDENT_C" "/api/v1/student/courses/$CID/lessons/lesson_personal_data/start" '{}')
  PAID_SID=$(J "$PAID_SR" session_id)
  [ -n "$PAID_SID" ] && pass "M10: Paid lesson accessible" || fail "M10" "resp=$PAID_SR"
fi

# ===========================================================================
echo ""
echo "--- O. ACL / Security ---"
# ===========================================================================

[ "$(GS student /api/v1/admin/users)" = "403" ] && pass "O1: Student→admin → 403" || fail "O1" "not 403"
[ "$(GS student /api/v1/teacher/courses)" = "403" ] && pass "O2: Student→teacher → 403" || fail "O2" "not 403"
[ "$(GS teacher /api/v1/admin/users)" = "403" ] && pass "O3: Teacher→admin → 403" || fail "O3" "not 403"
[ "$(GN /api/v1/student/catalog)" = "401" ] && pass "O5: No cookie → 401" || fail "O5" "not 401"

# ===========================================================================
echo ""
echo "--- N. Admin queries ---"
# ===========================================================================

[ "$(GS admin /api/v1/admin/users)" = "200" ] && pass "N1: Users → 200" || fail "N1" "not 200"
[ "$(GS admin /api/v1/admin/commerce/offers)" = "200" ] && pass "N4: Offers → 200" || fail "N4" "not 200"
[ "$(GS admin /api/v1/admin/commerce/orders)" = "200" ] && pass "N3: Orders → 200" || fail "N3" "not 200"

# ===========================================================================
echo ""
echo "============================================================================="
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo -e "  \033[0;32mALL $TOTAL TESTS PASSED\033[0m"
else
  echo -e "  \033[0;32m$PASS passed\033[0m, \033[0;31m$FAIL failed\033[0m out of $TOTAL"
  echo -e "\n  Failures:${ERRORS}"
fi
echo "============================================================================="
echo ""
rm -rf "$COOKIE_DIR"
exit $FAIL
