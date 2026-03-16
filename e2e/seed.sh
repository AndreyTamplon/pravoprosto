#!/usr/bin/env bash
# =============================================================================
# Право Просто — E2E seed script
#
# Seeds the backend with test data for manual e2e testing.
# Prerequisites:
#   1. PostgreSQL running, database "pravoprost_e2e" created
#   2. Mock servers running:  go run ./backend/cmd/mockserver
#   3. Backend running:       go run ./backend/cmd/server
#
# Usage:
#   chmod +x e2e/seed.sh
#   ./e2e/seed.sh
# =============================================================================

set -euo pipefail

BASE="${PRAVO_BASE_URL:-http://localhost:8080}"
DB_URL="${PRAVO_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/pravoprost_e2e?sslmode=disable}"
COOKIE_DIR="$(mktemp -d)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[-]${NC} $*"; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# login_as CODE COOKIE_FILE — performs SSO flow and returns CSRF token
login_as() {
  local code="$1"
  local jar="$COOKIE_DIR/$2.txt"

  # Step 1: Start SSO flow — follow redirect to get state cookie
  local start_resp
  start_resp=$(curl -sS -c "$jar" -D - -o /dev/null \
    "$BASE/api/v1/auth/sso/yandex/start" 2>&1)

  # Extract redirect location (the mock SSO authorize URL)
  local authorize_url
  authorize_url=$(echo "$start_resp" | grep -i '^location:' | tail -1 | tr -d '\r' | sed 's/^[Ll]ocation: *//')

  if [ -z "$authorize_url" ]; then
    error "Failed to get authorize URL for $code"
    return 1
  fi

  # Step 2: Extract state and redirect_uri from authorize URL, build callback
  local state redirect_uri callback_url
  state=$(echo "$authorize_url" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')
  redirect_uri=$(echo "$authorize_url" | sed -n 's/.*[?&]redirect_uri=\([^&]*\).*/\1/p')

  # URL-decode redirect_uri
  redirect_uri=$(python3 -c "import urllib.parse; print(urllib.parse.unquote('$redirect_uri'))" 2>/dev/null || echo "$redirect_uri")

  callback_url="${redirect_uri}?state=${state}&code=${code}"

  # Step 3: Hit callback — this creates account and session
  curl -sSL -b "$jar" -c "$jar" -D - -o /dev/null "$callback_url" 2>&1 >/dev/null

  # Step 4: Get session info (includes CSRF token)
  local session_json
  session_json=$(curl -sS -b "$jar" "$BASE/api/v1/session")

  local csrf
  csrf=$(echo "$session_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrf_token',''))" 2>/dev/null)

  if [ -z "$csrf" ]; then
    error "Failed to get CSRF for $code. Session response: $session_json"
    return 1
  fi

  echo "$csrf"
}

# api_post COOKIE_FILE CSRF PATH BODY — POST with auth
api_post() {
  local jar="$COOKIE_DIR/$1.txt" csrf="$2" path="$3" body="${4:-{}}"
  curl -sS -b "$jar" -X POST "$BASE$path" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $csrf" \
    -d "$body"
}

# api_put COOKIE_FILE CSRF PATH BODY
api_put() {
  local jar="$COOKIE_DIR/$1.txt" csrf="$2" path="$3" body="${4:-{}}"
  curl -sS -b "$jar" -X PUT "$BASE$path" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $csrf" \
    -d "$body"
}

# api_get COOKIE_FILE PATH
api_get() {
  local jar="$COOKIE_DIR/$1.txt" path="$2"
  curl -sS -b "$jar" "$BASE$path"
}

# json_field JSON KEY — extract field with python3
json_field() {
  echo "$1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$2',''))" 2>/dev/null
}

# ---------------------------------------------------------------------------
# 0. Health check
# ---------------------------------------------------------------------------

info "Checking services..."
curl -sS "$BASE/health" > /dev/null || { error "Backend not reachable at $BASE"; exit 1; }
curl -sS "http://localhost:8091/health" > /dev/null || { error "Mock SSO not reachable"; exit 1; }
curl -sS "http://localhost:8090/health" > /dev/null || { error "Mock LLM not reachable"; exit 1; }
info "All services are up."

# ---------------------------------------------------------------------------
# 1. Create accounts via SSO login
# ---------------------------------------------------------------------------

info "Logging in as admin..."
ADMIN_CSRF=$(login_as "admin" "admin")
info "  CSRF: ${ADMIN_CSRF:0:16}..."

info "Logging in as teacher..."
TEACHER_CSRF=$(login_as "teacher" "teacher")
info "  CSRF: ${TEACHER_CSRF:0:16}..."

info "Logging in as student..."
STUDENT_CSRF=$(login_as "student" "student")
info "  CSRF: ${STUDENT_CSRF:0:16}..."

info "Logging in as parent..."
PARENT_CSRF=$(login_as "parent" "parent")
info "  CSRF: ${PARENT_CSRF:0:16}..."

info "Logging in as student2..."
STUDENT2_CSRF=$(login_as "student2" "student2")
info "  CSRF: ${STUDENT2_CSRF:0:16}..."

# ---------------------------------------------------------------------------
# 2. Promote admin via direct DB access
# ---------------------------------------------------------------------------

info "Promoting admin account via database..."
ADMIN_ACCOUNT_ID=$(api_get "admin" "/api/v1/session" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('account_id',''))")

psql "$DB_URL" -q -c "
  UPDATE accounts SET role='admin', updated_at=now() WHERE id='$ADMIN_ACCOUNT_ID' AND role != 'admin';
  INSERT INTO admin_profiles(account_id, display_name, created_at, updated_at)
  VALUES ('$ADMIN_ACCOUNT_ID', 'Admin', now(), now())
  ON CONFLICT (account_id) DO NOTHING;
"
info "  Admin account: $ADMIN_ACCOUNT_ID"

# Re-login admin to pick up new role in session
ADMIN_CSRF=$(login_as "admin" "admin")

# ---------------------------------------------------------------------------
# 3. Select roles for other users
# ---------------------------------------------------------------------------

info "Selecting roles..."
api_post "teacher" "$TEACHER_CSRF" "/api/v1/onboarding/role" '{"role":"teacher"}' > /dev/null
info "  teacher → teacher"

api_post "student" "$STUDENT_CSRF" "/api/v1/onboarding/role" '{"role":"student"}' > /dev/null
info "  student → student"

api_post "parent" "$PARENT_CSRF" "/api/v1/onboarding/role" '{"role":"parent"}' > /dev/null
info "  parent → parent"

api_post "student2" "$STUDENT2_CSRF" "/api/v1/onboarding/role" '{"role":"student"}' > /dev/null
info "  student2 → student"

# ---------------------------------------------------------------------------
# 4. Create profiles
# ---------------------------------------------------------------------------

info "Creating profiles..."

api_put "teacher" "$TEACHER_CSRF" "/api/v1/teacher/profile" \
  '{"display_name":"Мария Ивановна","organization_name":"Школа №42"}' > /dev/null
info "  Teacher profile created"

api_put "student" "$STUDENT_CSRF" "/api/v1/student/profile" \
  '{"display_name":"Алиса","avatar_asset_id":null}' > /dev/null
info "  Student profile created"

api_put "parent" "$PARENT_CSRF" "/api/v1/parent/profile" \
  '{"display_name":"Елена","avatar_asset_id":null}' > /dev/null
info "  Parent profile created"

api_put "student2" "$STUDENT2_CSRF" "/api/v1/student/profile" \
  '{"display_name":"Борис","avatar_asset_id":null}' > /dev/null
info "  Student2 profile created"

# ---------------------------------------------------------------------------
# 5. Admin creates platform course
# ---------------------------------------------------------------------------

info "Creating platform course..."
COURSE_RESP=$(api_post "admin" "$ADMIN_CSRF" "/api/v1/admin/courses" \
  '{"title":"Безопасность в интернете","description":"Учимся защищать себя онлайн","age_min":8,"age_max":12}')
PLATFORM_COURSE_ID=$(json_field "$COURSE_RESP" "course_id")
info "  Course ID: $PLATFORM_COURSE_ID"

# Get draft version
DRAFT_RESP=$(api_get "admin" "/api/v1/admin/courses/$PLATFORM_COURSE_ID/draft")
DRAFT_VERSION=$(json_field "$DRAFT_RESP" "draft_version")

# Update draft with rich content
CONTENT_JSON=$(cat <<'ENDJSON'
{
  "modules": [
    {
      "id": "mod_safety",
      "title": "Основы безопасности",
      "lessons": [
        {
          "id": "lesson_phishing",
          "title": "Фишинг и мошенники",
          "graph": {
            "startNodeId": "s1",
            "nodes": [
              {
                "id": "s1",
                "kind": "story",
                "body": {"text": "Тебе пришло сообщение: «Поздравляем! Вы выиграли iPhone! Перейдите по ссылке, чтобы забрать приз.» Знакомая ситуация? Давай разберёмся, что делать."},
                "nextNodeId": "q1"
              },
              {
                "id": "q1",
                "kind": "single_choice",
                "prompt": "Что ты сделаешь с этим сообщением?",
                "options": [
                  {"id": "q1a", "text": "Перейду по ссылке — вдруг правда приз!", "result": "incorrect", "feedback": "Это классическая уловка мошенников. Никогда не переходи по подозрительным ссылкам!", "nextNodeId": "s2"},
                  {"id": "q1b", "text": "Покажу родителям и не буду переходить", "result": "correct", "feedback": "Верно! Если сообщение кажется подозрительным, лучше посоветоваться со взрослыми.", "nextNodeId": "s2"},
                  {"id": "q1c", "text": "Перешлю друзьям", "result": "incorrect", "feedback": "Пересылая мошенническое сообщение, ты подвергаешь друзей опасности!", "nextNodeId": "s2"}
                ]
              },
              {
                "id": "s2",
                "kind": "story",
                "body": {"text": "Мошенники часто используют приманки: «бесплатные» призы, срочные предупреждения о блокировке аккаунта, просьбы от «друзей» перевести деньги."},
                "nextNodeId": "q2"
              },
              {
                "id": "q2",
                "kind": "single_choice",
                "prompt": "Какой из признаков указывает на мошенническое сообщение?",
                "options": [
                  {"id": "q2a", "text": "Просят срочно перейти по ссылке", "result": "correct", "feedback": "Правильно! Срочность — один из главных приёмов мошенников.", "nextNodeId": "end1"},
                  {"id": "q2b", "text": "Сообщение от знакомого контакта", "result": "incorrect", "feedback": "Аккаунт знакомого тоже могут взломать. Но само по себе это не главный признак.", "nextNodeId": "end1"}
                ]
              },
              {
                "id": "end1",
                "kind": "end",
                "text": "Отлично! Теперь ты знаешь, как распознать мошенников."
              }
            ]
          }
        },
        {
          "id": "lesson_passwords",
          "title": "Надёжные пароли",
          "graph": {
            "startNodeId": "ps1",
            "nodes": [
              {
                "id": "ps1",
                "kind": "story",
                "body": {"text": "Пароль — это ключ к твоим данным. Если пароль простой, его легко подобрать. Давай проверим, знаешь ли ты правила создания надёжных паролей."},
                "nextNodeId": "pq1"
              },
              {
                "id": "pq1",
                "kind": "single_choice",
                "prompt": "Какой пароль самый надёжный?",
                "options": [
                  {"id": "pq1a", "text": "123456", "result": "incorrect", "feedback": "Это один из самых популярных и легко взламываемых паролей!", "nextNodeId": "pq2"},
                  {"id": "pq1b", "text": "мойкот2024", "result": "incorrect", "feedback": "Личная информация в пароле — плохая идея. Её легко угадать.", "nextNodeId": "pq2"},
                  {"id": "pq1c", "text": "Kx9#mL2$vQ", "result": "correct", "feedback": "Верно! Случайная комбинация букв, цифр и символов — самый надёжный пароль.", "nextNodeId": "pq2"}
                ]
              },
              {
                "id": "pq2",
                "kind": "free_text",
                "prompt": "Объясни своими словами, почему нельзя использовать один пароль для всех сайтов?",
                "rubric": {"referenceAnswer": "Если один сайт взломают, злоумышленники получат доступ ко всем остальным аккаунтам с этим же паролем"},
                "transitions": [
                  {"onVerdict": "correct", "nextNodeId": "pend"},
                  {"onVerdict": "partial", "nextNodeId": "pend"},
                  {"onVerdict": "incorrect", "nextNodeId": "pend"}
                ]
              },
              {
                "id": "pend",
                "kind": "end",
                "text": "Ты молодец! Теперь ты знаешь, как создавать надёжные пароли."
              }
            ]
          }
        }
      ]
    },
    {
      "id": "mod_data",
      "title": "Персональные данные",
      "lessons": [
        {
          "id": "lesson_personal_data",
          "title": "Что нельзя рассказывать в интернете",
          "graph": {
            "startNodeId": "d1",
            "nodes": [
              {
                "id": "d1",
                "kind": "story",
                "body": {"text": "В социальной сети тебе написал новый друг и просит рассказать, где ты живёшь и в какую школу ходишь. Как быть?"},
                "nextNodeId": "dq1"
              },
              {
                "id": "dq1",
                "kind": "single_choice",
                "prompt": "Стоит ли рассказывать незнакомцу в интернете свой адрес?",
                "options": [
                  {"id": "dq1a", "text": "Да, раз он дружелюбный", "result": "incorrect", "feedback": "Незнакомцы в интернете могут оказаться кем угодно. Никогда не сообщай личные данные!", "nextNodeId": "dend"},
                  {"id": "dq1b", "text": "Нет, это персональные данные", "result": "correct", "feedback": "Правильно! Адрес, телефон, номер школы — это персональные данные. Их нельзя сообщать незнакомцам.", "nextNodeId": "dend"}
                ]
              },
              {
                "id": "dend",
                "kind": "end",
                "text": "Помни: в интернете нужно быть осторожным с личной информацией!"
              }
            ]
          }
        }
      ]
    }
  ]
}
ENDJSON
)

DRAFT_BODY=$(python3 -c "
import json, sys
content = json.loads('''$CONTENT_JSON''')
body = {
    'draft_version': $DRAFT_VERSION,
    'title': 'Безопасность в интернете',
    'description': 'Учимся защищать себя онлайн',
    'age_min': 8,
    'age_max': 12,
    'cover_asset_id': None,
    'content': content
}
print(json.dumps(body, ensure_ascii=False))
")

api_put "admin" "$ADMIN_CSRF" "/api/v1/admin/courses/$PLATFORM_COURSE_ID/draft" "$DRAFT_BODY" > /dev/null
info "  Draft updated with 3 lessons (phishing, passwords, personal data)"

# Publish
PUB_RESP=$(api_post "admin" "$ADMIN_CSRF" "/api/v1/admin/courses/$PLATFORM_COURSE_ID/publish" '{}')
REVISION_ID=$(json_field "$PUB_RESP" "course_revision_id")
info "  Published revision: $REVISION_ID"

# ---------------------------------------------------------------------------
# 6. Teacher creates course and submits for review
# ---------------------------------------------------------------------------

info "Teacher creating course..."
TEACHER_COURSE_RESP=$(api_post "teacher" "$TEACHER_CSRF" "/api/v1/teacher/courses" \
  '{"title":"Покупки онлайн","description":"Как безопасно покупать в интернете","age_min":10,"age_max":14}')
TEACHER_COURSE_ID=$(json_field "$TEACHER_COURSE_RESP" "course_id")
info "  Teacher course ID: $TEACHER_COURSE_ID"

# Get draft version
T_DRAFT_RESP=$(api_get "teacher" "/api/v1/teacher/courses/$TEACHER_COURSE_ID/draft")
T_DRAFT_VERSION=$(json_field "$T_DRAFT_RESP" "draft_version")

T_CONTENT=$(cat <<'ENDJSON'
{
  "modules": [
    {
      "id": "mod_shop",
      "title": "Безопасные покупки",
      "lessons": [
        {
          "id": "lesson_shop1",
          "title": "Проверяем магазин",
          "graph": {
            "startNodeId": "ts1",
            "nodes": [
              {
                "id": "ts1",
                "kind": "story",
                "body": {"text": "Ты нашёл в интернете магазин с невероятно низкими ценами. iPhone за 5000 рублей! Стоит ли покупать?"},
                "nextNodeId": "tq1"
              },
              {
                "id": "tq1",
                "kind": "single_choice",
                "prompt": "Что ты сделаешь?",
                "options": [
                  {"id": "tq1a", "text": "Сразу куплю — такая скидка!", "result": "incorrect", "feedback": "Слишком низкая цена — признак мошенничества.", "nextNodeId": "tend"},
                  {"id": "tq1b", "text": "Проверю отзывы и сравню цены", "result": "correct", "feedback": "Молодец! Всегда проверяй магазин перед покупкой.", "nextNodeId": "tend"}
                ]
              },
              {
                "id": "tend",
                "kind": "end",
                "text": "Помни: если цена слишком хороша — скорее всего это обман."
              }
            ]
          }
        }
      ]
    }
  ]
}
ENDJSON
)

T_DRAFT_BODY=$(python3 -c "
import json
content = json.loads('''$T_CONTENT''')
body = {
    'draft_version': $T_DRAFT_VERSION,
    'title': 'Покупки онлайн',
    'description': 'Как безопасно покупать в интернете',
    'age_min': 10,
    'age_max': 14,
    'cover_asset_id': None,
    'content': content
}
print(json.dumps(body, ensure_ascii=False))
")

api_put "teacher" "$TEACHER_CSRF" "/api/v1/teacher/courses/$TEACHER_COURSE_ID/draft" "$T_DRAFT_BODY" > /dev/null
info "  Teacher draft updated"

# Submit for review
REVIEW_RESP=$(api_post "teacher" "$TEACHER_CSRF" "/api/v1/teacher/courses/$TEACHER_COURSE_ID/submit-review" '{}')
REVIEW_ID=$(json_field "$REVIEW_RESP" "review_id")
info "  Submitted for review: $REVIEW_ID"

# Admin approves
api_post "admin" "$ADMIN_CSRF" "/api/v1/admin/moderation/reviews/$REVIEW_ID/approve" \
  '{"comment":"Отличный курс!"}' > /dev/null
info "  Admin approved teacher course"

# ---------------------------------------------------------------------------
# 7. Teacher creates access link
# ---------------------------------------------------------------------------

info "Teacher creating access link..."
LINK_RESP=$(api_post "teacher" "$TEACHER_CSRF" "/api/v1/teacher/courses/$TEACHER_COURSE_ID/access-links" '{}')
ACCESS_TOKEN=$(json_field "$LINK_RESP" "token")
info "  Access link token: $ACCESS_TOKEN"

# ---------------------------------------------------------------------------
# 8. Create commercial offer for a paid lesson
# ---------------------------------------------------------------------------

info "Creating commercial offer for paid lesson..."
OFFER_RESP=$(api_post "admin" "$ADMIN_CSRF" "/api/v1/admin/commerce/offers" \
  "{\"target_type\":\"lesson\",\"target_course_id\":\"$PLATFORM_COURSE_ID\",\"target_lesson_id\":\"lesson_personal_data\",\"title\":\"Урок: Персональные данные\",\"description\":\"Платный урок о защите личных данных\",\"price_amount_minor\":49000,\"price_currency\":\"RUB\"}")
OFFER_ID=$(json_field "$OFFER_RESP" "offer_id")
info "  Offer ID: $OFFER_ID"

# Activate offer
api_put "admin" "$ADMIN_CSRF" "/api/v1/admin/commerce/offers/$OFFER_ID" \
  "{\"title\":\"Урок: Персональные данные\",\"description\":\"Платный урок о защите личных данных\",\"price_amount_minor\":49000,\"price_currency\":\"RUB\",\"status\":\"active\"}" > /dev/null
info "  Offer activated"

# ---------------------------------------------------------------------------
# 9. Guardianship: parent invites student
# ---------------------------------------------------------------------------

info "Setting up guardianship..."
INVITE_RESP=$(api_post "parent" "$PARENT_CSRF" "/api/v1/parent/children/link-invites" '{}')
# Extract token from claim_url (format: .../claim/guardian-link#token=<raw_token>)
INVITE_TOKEN=$(echo "$INVITE_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
url = d.get('claim_url', '')
if '#token=' in url:
    print(url.split('#token=')[1])
elif 'token=' in url:
    print(url.split('token=')[-1].split('&')[0])
else:
    print(d.get('token', ''))
" 2>/dev/null)
info "  Guardian invite token: $INVITE_TOKEN"

# Student claims invite
if [ -n "$INVITE_TOKEN" ]; then
  CLAIM_RESP=$(api_post "student" "$STUDENT_CSRF" "/api/v1/student/guardian-links/claim" "{\"token\":\"$INVITE_TOKEN\"}")
  info "  Student claimed guardian invite"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "============================================================================="
echo -e "${GREEN}  SEED COMPLETE${NC}"
echo "============================================================================="
echo ""
echo "Accounts:"
echo "  admin     — login code: admin"
echo "  teacher   — login code: teacher (Мария Ивановна, Школа №42)"
echo "  student   — login code: student (Алиса)"
echo "  parent    — login code: parent  (Елена, linked to student)"
echo "  student2  — login code: student2 (Борис, no guardian)"
echo ""
echo "Platform course: $PLATFORM_COURSE_ID"
echo "  Lessons: lesson_phishing (free), lesson_passwords (free+LLM), lesson_personal_data (PAID)"
echo "  Published revision: $REVISION_ID"
echo ""
echo "Teacher course: $TEACHER_COURSE_ID"
echo "  Status: approved & published"
echo "  Access link token: $ACCESS_TOKEN"
echo ""
echo "Commerce:"
echo "  Offer ID: $OFFER_ID (lesson_personal_data, 490 RUB)"
echo ""
echo "Guardian link: parent → student"
echo ""
echo "Cookie files are in: $COOKIE_DIR"
echo "  Use: curl -b $COOKIE_DIR/student.txt ..."
echo ""
echo "============================================================================="
