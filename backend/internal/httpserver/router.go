package httpserver

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"pravoprost/backend/internal/assets"
	"pravoprost/backend/internal/commerce"
	"pravoprost/backend/internal/courses"
	"pravoprost/backend/internal/evaluation"
	"pravoprost/backend/internal/guardianship"
	"pravoprost/backend/internal/identity"
	"pravoprost/backend/internal/lessonruntime"
	platformconfig "pravoprost/backend/internal/platform/config"
	"pravoprost/backend/internal/platform/db"
	"pravoprost/backend/internal/profiles"
	"pravoprost/backend/internal/teacheraccess"
)

type Dependencies struct {
	Config        platformconfig.Config
	DB            *db.DB
	Identity      *identity.Service
	Profiles      *profiles.Service
	Assets        *assets.Service
	Guardianship  *guardianship.Service
	Courses       *courses.Service
	LessonRuntime *lessonruntime.Service
	TeacherAccess *teacheraccess.Service
	Commerce      *commerce.Service
}

func NewRouter(deps Dependencies) http.Handler {
	router := chi.NewRouter()
	router.Use(limitRequestBody(deps.Config.MaxRequestBodyBytes))
	router.Use(securityHeaders)

	if deps.Identity == nil {
		registry := identity.NewProviderRegistry()
		if deps.Config.YandexClientID != "" {
			registry.Register(identity.NewYandexProvider(identity.YandexProviderConfig{
				ClientID:     deps.Config.YandexClientID,
				ClientSecret: deps.Config.YandexClientSecret,
				AuthURL:      deps.Config.YandexAuthURL,
				TokenURL:     deps.Config.YandexTokenURL,
				UserInfoURL:  deps.Config.YandexUserInfoURL,
			}))
		} else if deps.Config.SSOBaseURL != "" {
			registry.Register(identity.NewLegacyExternalProvider("yandex", deps.Config.SSOBaseURL))
		}
		deps.Identity = identity.NewService(deps.DB.Pool(), deps.Config, registry)
	}
	if deps.Profiles == nil {
		deps.Profiles = profiles.NewService(deps.DB.Pool())
	}
	if deps.Assets == nil {
		deps.Assets = assets.NewService(deps.DB.Pool())
	}
	if deps.Guardianship == nil {
		deps.Guardianship = guardianship.NewService(deps.DB.Pool(), deps.Config)
	}
	if deps.Courses == nil {
		deps.Courses = courses.NewService(deps.DB.Pool(), evaluation.NewOpenAICompatibleAdapter(deps.Config))
	}
	if deps.LessonRuntime == nil {
		deps.LessonRuntime = lessonruntime.NewService(deps.DB.Pool(), deps.Config, evaluation.NewOpenAICompatibleAdapter(deps.Config))
	}
	if deps.TeacherAccess == nil {
		deps.TeacherAccess = teacheraccess.NewService(deps.DB.Pool(), deps.Config)
	}
	if deps.Commerce == nil {
		deps.Commerce = commerce.NewService(deps.DB.Pool())
	}

	router.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	router.Route("/api/v1", func(r chi.Router) {
		r.Get("/session", func(w http.ResponseWriter, r *http.Request) {
			view, err := deps.Identity.SessionView(r.Context(), r)
			if err != nil {
				writeInternalError(w)
				return
			}
			writeJSON(w, http.StatusOK, view)
		})
		r.Get("/public/promo-courses", func(w http.ResponseWriter, r *http.Request) {
			view, err := deps.Courses.PromoCourses(r.Context())
			if err != nil {
				writeInternalError(w)
				return
			}
			writeJSON(w, http.StatusOK, view)
		})

		r.Post("/auth/logout", requireAuth(func(w http.ResponseWriter, r *http.Request) {
			session, _ := sessionFromContext(r.Context())
			if !secureEquals(r.Header.Get(deps.Config.CSRFHeaderName), session.CSRFSecret) {
				writeError(w, http.StatusForbidden, "forbidden", "CSRF token missing or invalid", nil)
				return
			}
			if err := deps.Identity.Logout(r.Context(), session.SessionID); err != nil {
				writeInternalError(w)
				return
			}
			http.SetCookie(w, &http.Cookie{
				Name:     deps.Config.SessionCookieName,
				Value:    "",
				Path:     "/",
				MaxAge:   -1,
				HttpOnly: true,
				Secure:   deps.Config.CookieSecure,
				SameSite: http.SameSiteLaxMode,
			})
			w.WriteHeader(http.StatusNoContent)
		}, deps))

		r.With(rateLimitByIP(10, time.Minute)).Get("/auth/sso/{provider}/start", func(w http.ResponseWriter, r *http.Request) {
			result, err := deps.Identity.StartSSO(chi.URLParam(r, "provider"), r.URL.Query().Get("return_to"))
			if err != nil {
				switch err {
				case identity.ErrInvalidReturnTo:
					writeError(w, http.StatusForbidden, "invalid_return_to", "Invalid return_to", nil)
				case identity.ErrUnknownProvider:
					writeError(w, http.StatusBadRequest, "unknown_provider", "Unknown SSO provider", nil)
				default:
					writeInternalError(w)
				}
				return
			}
			http.SetCookie(w, result.StateCookie)
			http.Redirect(w, r, result.RedirectURL, http.StatusFound)
		})

		r.Get("/auth/sso/{provider}/callback", func(w http.ResponseWriter, r *http.Request) {
			stateCookie, _ := r.Cookie("pravoprost_oauth_state")
			result, err := deps.Identity.Callback(r.Context(), identity.SSOCallbackInput{
				Provider: chi.URLParam(r, "provider"),
				Query:    r.URL.Query(),
			}, stateCookie)
			if err != nil {
				switch err {
				case identity.ErrInvalidState:
					writeError(w, http.StatusBadRequest, "invalid_sso_state", "Invalid SSO state", nil)
				case identity.ErrUnknownProvider:
					writeError(w, http.StatusBadRequest, "unknown_provider", "Unknown SSO provider", nil)
				case identity.ErrAccountBlocked:
					writeError(w, http.StatusForbidden, "account_blocked", "Account is blocked", nil)
				default:
					writeInternalError(w)
				}
				return
			}
			http.SetCookie(w, result.SessionCookie)
			http.SetCookie(w, &http.Cookie{
				Name:     "pravoprost_oauth_state",
				Value:    "",
				Path:     "/",
				MaxAge:   -1,
				HttpOnly: true,
				Secure:   deps.Config.CookieSecure,
				SameSite: http.SameSiteLaxMode,
			})
			http.Redirect(w, r, result.RedirectURL, http.StatusFound)
		})

		r.Post("/onboarding/role", requireAuth(func(w http.ResponseWriter, r *http.Request) {
			session, _ := sessionFromContext(r.Context())
			if !secureEquals(r.Header.Get(deps.Config.CSRFHeaderName), session.CSRFSecret) {
				writeError(w, http.StatusForbidden, "forbidden", "CSRF token missing or invalid", nil)
				return
			}
			var body struct {
				Role string `json:"role"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
				return
			}
			accountID, role, err := deps.Identity.CompleteRoleSelection(r.Context(), session.AccountID, body.Role)
			if err != nil {
				switch err {
				case identity.ErrRoleAlreadySet:
					writeError(w, http.StatusConflict, "role_already_set", "Role already set", nil)
				case identity.ErrForbiddenAdminRoleSelection:
					writeError(w, http.StatusForbidden, "forbidden_admin_role_selection", "Admin role cannot be selected", nil)
				case identity.ErrInvalidRoleSelection:
					writeError(w, http.StatusUnprocessableEntity, "invalid_role_selection", "Invalid role selection", nil)
				default:
					writeInternalError(w)
				}
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{
				"account_id": accountID,
				"role":       role,
			})
		}, deps))

		r.Post("/assets/upload-requests", requireAuth(func(w http.ResponseWriter, r *http.Request) {
			session, _ := sessionFromContext(r.Context())
			if !secureEquals(r.Header.Get(deps.Config.CSRFHeaderName), session.CSRFSecret) {
				writeError(w, http.StatusForbidden, "forbidden", "CSRF token missing or invalid", nil)
				return
			}
			input, err := assets.DecodeUploadRequest(r)
			if err != nil {
				writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
				return
			}
			view, err := deps.Assets.CreateUploadRequest(r.Context(), session.AccountID, input)
			if err != nil {
				writeError(w, http.StatusUnprocessableEntity, "invalid_asset_upload", "Invalid asset upload", nil)
				return
			}
			writeJSON(w, http.StatusCreated, view)
		}, deps))

		r.Route("/student", func(sr chi.Router) {
			sr.Get("/catalog", requireRole("student", deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.LessonRuntime.Catalog(r.Context(), session.AccountID)
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			sr.Get("/game-state", requireRole("student", deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.LessonRuntime.GameState(r.Context(), session.AccountID)
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			sr.Get("/courses/{courseID}", requireRole("student", deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.LessonRuntime.CourseTree(r.Context(), session.AccountID, chi.URLParam(r, "courseID"))
				if err != nil {
					if err == lessonruntime.ErrLockedTeacherAccess {
						writeError(w, http.StatusForbidden, "locked_teacher_access", "Teacher course access is locked", nil)
						return
					}
					writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			sr.Post("/courses/{courseID}/lessons/{lessonID}/start", requireRole("student", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.LessonRuntime.StartLesson(r.Context(), session.AccountID, chi.URLParam(r, "courseID"), chi.URLParam(r, "lessonID"))
				if err != nil {
					switch err {
					case lessonruntime.ErrLockedTeacherAccess:
						writeError(w, http.StatusForbidden, "locked_teacher_access", "Teacher course access is locked", nil)
					case lessonruntime.ErrLockedPrerequisite:
						writeError(w, http.StatusConflict, "locked_prerequisite", "Lesson is locked by prerequisite", nil)
					case lessonruntime.ErrContentLockedPaid:
						writeError(w, http.StatusConflict, "content_locked_paid", "Content is locked by paywall", nil)
					case lessonruntime.ErrContentAccessAwaitingConfirmation:
						writeError(w, http.StatusConflict, "content_access_awaiting_confirmation", "Content awaits payment confirmation", nil)
					case lessonruntime.ErrLLMTemporarilyUnavailable:
						writeError(w, http.StatusServiceUnavailable, "llm_temporarily_unavailable", "LLM is temporarily unavailable", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			sr.Get("/courses/{courseID}/lessons/{lessonID}/session", requireRole("student", deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.LessonRuntime.SessionByCourseLesson(r.Context(), session.AccountID, chi.URLParam(r, "courseID"), chi.URLParam(r, "lessonID"))
				if err != nil {
					switch err {
					case lessonruntime.ErrLessonSessionNotFound:
						writeError(w, http.StatusNotFound, "lesson_session_not_found", "Lesson session not found", nil)
					case lessonruntime.ErrLockedTeacherAccess:
						writeError(w, http.StatusForbidden, "locked_teacher_access", "Teacher course access is locked", nil)
					case lessonruntime.ErrContentLockedPaid:
						writeError(w, http.StatusConflict, "content_locked_paid", "Content is locked by paywall", nil)
					case lessonruntime.ErrContentAccessAwaitingConfirmation:
						writeError(w, http.StatusConflict, "content_access_awaiting_confirmation", "Content awaits payment confirmation", nil)
					case lessonruntime.ErrLLMTemporarilyUnavailable:
						writeError(w, http.StatusServiceUnavailable, "llm_temporarily_unavailable", "LLM is temporarily unavailable", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			sr.Get("/lesson-sessions/{sessionID}", requireRole("student", deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.LessonRuntime.SessionByID(r.Context(), session.AccountID, chi.URLParam(r, "sessionID"))
				if err != nil {
					switch err {
					case lessonruntime.ErrLessonSessionNotFound:
						writeError(w, http.StatusNotFound, "lesson_session_not_found", "Lesson session not found", nil)
					case lessonruntime.ErrLessonSessionNotActive:
						writeError(w, http.StatusConflict, "lesson_session_not_active", "Lesson session not active", nil)
					case lessonruntime.ErrLockedTeacherAccess:
						writeError(w, http.StatusForbidden, "locked_teacher_access", "Teacher course access is locked", nil)
					case lessonruntime.ErrContentLockedPaid:
						writeError(w, http.StatusConflict, "content_locked_paid", "Content is locked by paywall", nil)
					case lessonruntime.ErrContentAccessAwaitingConfirmation:
						writeError(w, http.StatusConflict, "content_access_awaiting_confirmation", "Content awaits payment confirmation", nil)
					case lessonruntime.ErrLLMTemporarilyUnavailable:
						writeError(w, http.StatusServiceUnavailable, "llm_temporarily_unavailable", "LLM is temporarily unavailable", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			sr.Post("/guardian-links/claim", requireRole("student", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				token, err := guardianship.DecodeClaimRequest(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Guardianship.ClaimInvite(r.Context(), session.AccountID, token)
				if err != nil {
					switch err {
					case guardianship.ErrInviteNotFound:
						writeError(w, http.StatusNotFound, "invite_not_found", "Invite not found", nil)
					case guardianship.ErrInviteAlreadyUsed:
						writeError(w, http.StatusConflict, "invite_already_used", "Invite already used", nil)
					case guardianship.ErrInviteInvalidState:
						writeError(w, http.StatusConflict, "invite_invalid_state", "Invite is no longer active", nil)
					case guardianship.ErrInviteExpired:
						writeError(w, http.StatusConflict, "invite_expired", "Invite expired", nil)
					case guardianship.ErrGuardianLimitReached:
						writeError(w, http.StatusConflict, "guardian_limit_reached", "Guardian limit reached", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			sr.Post("/course-links/claim", requireRole("student", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				token, err := teacheraccess.DecodeClaim(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.TeacherAccess.ClaimLink(r.Context(), session.AccountID, token)
				if err != nil {
					switch err {
					case teacheraccess.ErrLinkNotFound:
						writeError(w, http.StatusNotFound, "course_link_not_found", "Course link not found", nil)
					case teacheraccess.ErrLinkRevoked:
						writeError(w, http.StatusConflict, "course_link_revoked", "Course link revoked", nil)
					case teacheraccess.ErrLinkExpired:
						writeError(w, http.StatusConflict, "course_link_expired", "Course link expired", nil)
					case teacheraccess.ErrCourseNotPublished:
						writeError(w, http.StatusConflict, "course_not_published", "Course not published", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			sr.Post("/offers/{offerID}/purchase-requests", requireRole("student", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Commerce.CreatePurchaseRequest(r.Context(), session.AccountID, chi.URLParam(r, "offerID"))
				if err != nil {
					switch err {
					case commerce.ErrOfferNotFound:
						writeError(w, http.StatusNotFound, "offer_not_found", "Offer not found", nil)
					case commerce.ErrOfferNotActive:
						writeError(w, http.StatusConflict, "offer_not_active", "Offer not active", nil)
					case commerce.ErrPurchaseRequestAlreadyOpen:
						writeError(w, http.StatusConflict, "purchase_request_already_open", "Purchase request already open", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusCreated, view)
			}, deps)))
			sr.Post("/lesson-sessions/{sessionID}/next", requireRole("student", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				stateVersion, expectedNodeID, err := lessonruntime.DecodeNextRequest(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.LessonRuntime.Next(r.Context(), session.AccountID, chi.URLParam(r, "sessionID"), stateVersion, expectedNodeID)
				if err != nil {
					switch err {
					case lessonruntime.ErrLessonSessionNotFound:
						writeError(w, http.StatusNotFound, "lesson_session_not_found", "Lesson session not found", nil)
					case lessonruntime.ErrLessonSessionNotActive:
						writeError(w, http.StatusConflict, "lesson_session_not_active", "Lesson session not active", nil)
					case lessonruntime.ErrLessonSessionStateConflict:
						writeError(w, http.StatusConflict, "lesson_session_state_conflict", "Lesson session state conflict", nil)
					case lessonruntime.ErrLockedTeacherAccess:
						writeError(w, http.StatusForbidden, "locked_teacher_access", "Teacher course access is locked", nil)
					case lessonruntime.ErrContentLockedPaid:
						writeError(w, http.StatusConflict, "content_locked_paid", "Content is locked by paywall", nil)
					case lessonruntime.ErrContentAccessAwaitingConfirmation:
						writeError(w, http.StatusConflict, "content_access_awaiting_confirmation", "Content awaits payment confirmation", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			sr.Post("/lesson-sessions/{sessionID}/answer", requireRole("student", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				idempotencyKey := r.Header.Get("Idempotency-Key")
				if idempotencyKey == "" {
					writeError(w, http.StatusBadRequest, "bad_request", "Missing Idempotency-Key", nil)
					return
				}
				stateVersion, nodeID, answer, err := lessonruntime.DecodeAnswerRequest(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.LessonRuntime.Answer(r.Context(), session.AccountID, chi.URLParam(r, "sessionID"), stateVersion, nodeID, answer, idempotencyKey)
				if err != nil {
					switch err {
					case lessonruntime.ErrAnswerOnNonQuestionNode:
						writeError(w, http.StatusConflict, "answer_on_non_question_node", "Answer is only allowed on question nodes", nil)
					case lessonruntime.ErrLessonSessionNotFound:
						writeError(w, http.StatusNotFound, "lesson_session_not_found", "Lesson session not found", nil)
					case lessonruntime.ErrLessonSessionNotActive:
						writeError(w, http.StatusConflict, "lesson_session_not_active", "Lesson session not active", nil)
					case lessonruntime.ErrLessonSessionStateConflict:
						writeError(w, http.StatusConflict, "lesson_session_state_conflict", "Lesson session state conflict", nil)
					case lessonruntime.ErrDuplicateAnswerSubmission:
						writeError(w, http.StatusConflict, "duplicate_answer_submission", "Duplicate answer submission", nil)
					case lessonruntime.ErrOutOfHearts:
						writeError(w, http.StatusConflict, "out_of_hearts", "Out of hearts", nil)
					case lessonruntime.ErrLockedTeacherAccess:
						writeError(w, http.StatusForbidden, "locked_teacher_access", "Teacher course access is locked", nil)
					case lessonruntime.ErrContentLockedPaid:
						writeError(w, http.StatusConflict, "content_locked_paid", "Content is locked by paywall", nil)
					case lessonruntime.ErrContentAccessAwaitingConfirmation:
						writeError(w, http.StatusConflict, "content_access_awaiting_confirmation", "Content awaits payment confirmation", nil)
					case lessonruntime.ErrLLMTemporarilyUnavailable:
						writeError(w, http.StatusServiceUnavailable, "llm_temporarily_unavailable", "LLM is temporarily unavailable", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			sr.Post("/courses/{courseID}/lessons/{lessonID}/retry", requireRole("student", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.LessonRuntime.Retry(r.Context(), session.AccountID, chi.URLParam(r, "courseID"), chi.URLParam(r, "lessonID"))
				if err != nil {
					switch err {
					case lessonruntime.ErrLessonRetryNotAllowed:
						writeError(w, http.StatusConflict, "lesson_retry_not_allowed", "Lesson retry is not allowed", nil)
					case lessonruntime.ErrLockedTeacherAccess:
						writeError(w, http.StatusForbidden, "locked_teacher_access", "Teacher course access is locked", nil)
					case lessonruntime.ErrContentLockedPaid:
						writeError(w, http.StatusConflict, "content_locked_paid", "Content is locked by paywall", nil)
					case lessonruntime.ErrContentAccessAwaitingConfirmation:
						writeError(w, http.StatusConflict, "content_access_awaiting_confirmation", "Content awaits payment confirmation", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			sr.Get("/profile", requireRole("student", deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Profiles.GetStudent(r.Context(), session.AccountID)
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			sr.Put("/profile", requireRole("student", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := profiles.DecodeUpdateProfile(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Profiles.UpdateStudent(r.Context(), session.AccountID, input)
				if err != nil {
					if err.Error() == "asset_not_owned" {
						writeError(w, http.StatusUnprocessableEntity, "asset_not_owned", "Asset must belong to the same account", nil)
						return
					}
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
		})

		r.Route("/parent", func(pr chi.Router) {
			pr.Get("/children", requireRole("parent", deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Guardianship.ListChildren(r.Context(), session.AccountID)
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			pr.Post("/children/link-invites", requireRole("parent", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Guardianship.CreateInvite(r.Context(), session.AccountID)
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusCreated, view)
			}, deps)))
			pr.Get("/children/link-invites", requireRole("parent", deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Guardianship.ListInvites(r.Context(), session.AccountID)
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			pr.Post("/children/link-invites/{inviteID}/revoke", requireRole("parent", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Guardianship.RevokeInvite(r.Context(), session.AccountID, chi.URLParam(r, "inviteID"))
				if err != nil {
					switch err {
					case guardianship.ErrInviteNotFound:
						writeError(w, http.StatusNotFound, "invite_not_found", "Invite not found", nil)
					case guardianship.ErrInviteAlreadyResolved:
						writeError(w, http.StatusConflict, "invite_already_resolved", "Invite already resolved", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			pr.Get("/children/{studentID}/progress", requireRole("parent", deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Guardianship.ChildProgress(r.Context(), session.AccountID, chi.URLParam(r, "studentID"))
				if err != nil {
					if err == guardianship.ErrChildNotVisible {
						writeError(w, http.StatusForbidden, "forbidden", "Forbidden", nil)
						return
					}
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			pr.Get("/profile", requireRole("parent", deps, basicProfileGetHandler("parent", deps)))
			pr.Put("/profile", requireRole("parent", deps, requireCSRF(basicProfilePutHandler("parent", deps), deps)))
		})

		r.Route("/teacher", func(tr chi.Router) {
			tr.Get("/courses", requireTeacherReady(deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Courses.ListCourses(r.Context(), "teacher", session.AccountID)
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			tr.Post("/courses", requireTeacherReady(deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := courses.DecodeCreateCourse(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Courses.CreateCourse(r.Context(), "teacher", session.AccountID, input)
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusCreated, view)
			}, deps)))
			tr.Get("/courses/{courseID}/draft", requireTeacherReady(deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Courses.GetDraft(r.Context(), "teacher", session.AccountID, chi.URLParam(r, "courseID"))
				if err != nil {
					if err == courses.ErrCourseNotFound {
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
						return
					}
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			tr.Put("/courses/{courseID}/draft", requireTeacherReady(deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := courses.DecodeUpdateDraft(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Courses.UpdateDraft(r.Context(), "teacher", session.AccountID, chi.URLParam(r, "courseID"), input)
				if err != nil {
					switch err {
					case courses.ErrDraftVersionConflict:
						writeError(w, http.StatusConflict, "draft_version_conflict", "Draft version conflict", nil)
					case courses.ErrDraftValidationFailed:
						validation := view["validation"].(courses.ValidationView)
						writeError(w, http.StatusUnprocessableEntity, "draft_validation_failed", "Draft contains validation errors", map[string]any{"errors": validation.Errors})
					case courses.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			tr.Post("/courses/{courseID}/preview", requireTeacherReady(deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := courses.DecodePreviewStart(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Courses.StartPreview(r.Context(), "teacher", session.AccountID, chi.URLParam(r, "courseID"), input.LessonID)
				if err != nil {
					switch err {
					case courses.ErrDraftValidationFailed:
						writeError(w, http.StatusUnprocessableEntity, "draft_validation_failed", "Draft contains validation errors", nil)
					case courses.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			tr.Post("/courses/{courseID}/submit-review", requireTeacherReady(deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Courses.SubmitReview(r.Context(), session.AccountID, chi.URLParam(r, "courseID"))
				if err != nil {
					switch err {
					case courses.ErrModerationReviewAlreadyPending:
						writeError(w, http.StatusConflict, "moderation_review_already_pending", "Review already pending", nil)
					case courses.ErrDraftValidationFailed:
						writeError(w, http.StatusUnprocessableEntity, "draft_validation_failed", "Draft contains validation errors", nil)
					case courses.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			tr.Get("/courses/{courseID}/review-status", requireTeacherReady(deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Courses.ReviewStatus(r.Context(), session.AccountID, chi.URLParam(r, "courseID"))
				if err != nil {
					if err == courses.ErrCourseNotFound {
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
						return
					}
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			tr.Post("/courses/{courseID}/access-links", requireTeacherReady(deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := teacheraccess.DecodeCreateLink(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.TeacherAccess.CreateLink(r.Context(), session.AccountID, chi.URLParam(r, "courseID"), input)
				if err != nil {
					switch err {
					case teacheraccess.ErrCourseNotPublished:
						writeError(w, http.StatusConflict, "course_not_published", "Course not published", nil)
					case teacheraccess.ErrCourseNotTeacherPrivate:
						writeError(w, http.StatusConflict, "course_not_teacher_private", "Course is not teacher private", nil)
					case teacheraccess.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusCreated, view)
			}, deps)))
			tr.Get("/courses/{courseID}/access-links", requireTeacherReady(deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.TeacherAccess.ListLinks(r.Context(), session.AccountID, chi.URLParam(r, "courseID"))
				if err != nil {
					switch err {
					case teacheraccess.ErrCourseNotTeacherPrivate:
						writeError(w, http.StatusConflict, "course_not_teacher_private", "Course is not teacher private", nil)
					case teacheraccess.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			tr.Post("/access-links/{linkID}/revoke", requireTeacherReady(deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.TeacherAccess.RevokeLink(r.Context(), session.AccountID, chi.URLParam(r, "linkID"))
				if err != nil {
					switch err {
					case teacheraccess.ErrLinkNotFound:
						writeError(w, http.StatusNotFound, "course_link_not_found", "Course link not found", nil)
					case teacheraccess.ErrLinkAlreadyResolved:
						writeError(w, http.StatusConflict, "course_link_already_resolved", "Course link already resolved", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			tr.Get("/courses/{courseID}/students", requireTeacherReady(deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.TeacherAccess.ListStudents(r.Context(), session.AccountID, chi.URLParam(r, "courseID"))
				if err != nil {
					switch err {
					case teacheraccess.ErrCourseNotTeacherPrivate:
						writeError(w, http.StatusConflict, "course_not_teacher_private", "Course is not teacher private", nil)
					case teacheraccess.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			tr.Get("/courses/{courseID}/students/{studentID}", requireTeacherReady(deps, func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.TeacherAccess.StudentDetail(r.Context(), session.AccountID, chi.URLParam(r, "courseID"), chi.URLParam(r, "studentID"))
				if err != nil {
					switch err {
					case teacheraccess.ErrStudentNotVisible:
						writeError(w, http.StatusForbidden, "forbidden", "Forbidden", nil)
					case teacheraccess.ErrCourseNotTeacherPrivate:
						writeError(w, http.StatusConflict, "course_not_teacher_private", "Course is not teacher private", nil)
					case teacheraccess.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			tr.Post("/courses/{courseID}/archive", requireTeacherReady(deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Courses.ArchiveCourse(r.Context(), session.AccountID, chi.URLParam(r, "courseID"))
				if err != nil {
					if err == courses.ErrCourseNotFound {
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
						return
					}
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			tr.Get("/profile", requireRole("teacher", deps, basicProfileGetHandler("teacher", deps)))
			tr.Put("/profile", requireRole("teacher", deps, requireCSRF(basicProfilePutHandler("teacher", deps), deps)))
		})

		r.Route("/admin", func(ar chi.Router) {
			ar.Get("/courses", requireRole("admin", deps, func(w http.ResponseWriter, r *http.Request) {
				view, err := deps.Courses.ListCourses(r.Context(), "admin", "")
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			ar.Post("/courses", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := courses.DecodeCreateCourse(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Courses.CreateCourse(r.Context(), "admin", session.AccountID, input)
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusCreated, view)
			}, deps)))
			ar.Get("/courses/{courseID}/draft", requireRole("admin", deps, func(w http.ResponseWriter, r *http.Request) {
				view, err := deps.Courses.GetDraft(r.Context(), "admin", "", chi.URLParam(r, "courseID"))
				if err != nil {
					if err == courses.ErrCourseNotFound {
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
						return
					}
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			ar.Put("/courses/{courseID}/draft", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				input, err := courses.DecodeUpdateDraft(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Courses.UpdateDraft(r.Context(), "admin", "", chi.URLParam(r, "courseID"), input)
				if err != nil {
					switch err {
					case courses.ErrDraftVersionConflict:
						writeError(w, http.StatusConflict, "draft_version_conflict", "Draft version conflict", nil)
					case courses.ErrDraftValidationFailed:
						validation := view["validation"].(courses.ValidationView)
						writeError(w, http.StatusUnprocessableEntity, "draft_validation_failed", "Draft contains validation errors", map[string]any{"errors": validation.Errors})
					case courses.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			ar.Post("/courses/{courseID}/preview", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := courses.DecodePreviewStart(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Courses.StartPreview(r.Context(), "admin", session.AccountID, chi.URLParam(r, "courseID"), input.LessonID)
				if err != nil {
					switch err {
					case courses.ErrDraftValidationFailed:
						writeError(w, http.StatusUnprocessableEntity, "draft_validation_failed", "Draft contains validation errors", nil)
					case courses.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			ar.Post("/courses/{courseID}/publish", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Courses.PublishCourse(r.Context(), chi.URLParam(r, "courseID"), session.AccountID)
				if err != nil {
					switch err {
					case courses.ErrCourseNotPlatformOwned:
						writeError(w, http.StatusConflict, "course_not_platform_owned", "Course must be platform-owned for direct publish", nil)
					case courses.ErrCourseNotPublishable:
						writeError(w, http.StatusUnprocessableEntity, "course_not_publishable", "Course cannot be published", nil)
					case courses.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			ar.Post("/courses/{courseID}/access-grants", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				var body struct {
					StudentID string `json:"student_id"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.TeacherAccess.AdminGrant(r.Context(), session.AccountID, chi.URLParam(r, "courseID"), body.StudentID)
				if err != nil {
					switch err {
					case teacheraccess.ErrInvalidStudentID:
						writeError(w, http.StatusUnprocessableEntity, "invalid_student_id", "Student id must be a valid student account", nil)
					case teacheraccess.ErrStudentRoleRequired:
						writeError(w, http.StatusUnprocessableEntity, "invalid_student_id", "Student id must be a valid student account", nil)
					case teacheraccess.ErrPlatformContentMustUseEntitlement:
						writeError(w, http.StatusConflict, "platform_content_must_use_entitlement", "Platform content must use entitlement", nil)
					case teacheraccess.ErrCourseNotPublished:
						writeError(w, http.StatusConflict, "course_not_published", "Course not published", nil)
					case teacheraccess.ErrCourseNotFound:
						writeError(w, http.StatusNotFound, "course_not_found", "Course not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusCreated, view)
			}, deps)))
			ar.Get("/users", requireRole("admin", deps, func(w http.ResponseWriter, r *http.Request) {
				view, err := deps.Identity.ListUsers(r.Context(), r.URL.Query().Get("role"))
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			ar.Get("/users/{userID}", requireRole("admin", deps, func(w http.ResponseWriter, r *http.Request) {
				view, err := deps.Identity.UserDetail(r.Context(), chi.URLParam(r, "userID"))
				if err != nil {
					if err == identity.ErrUserNotFound {
						writeError(w, http.StatusNotFound, "user_not_found", "User not found", nil)
						return
					}
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			ar.Get("/moderation/queue", requireRole("admin", deps, func(w http.ResponseWriter, r *http.Request) {
				view, err := deps.Courses.ModerationQueue(r.Context())
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			ar.Get("/moderation/reviews/{reviewID}/draft", requireRole("admin", deps, func(w http.ResponseWriter, r *http.Request) {
				view, err := deps.Courses.ModerationDraft(r.Context(), chi.URLParam(r, "reviewID"))
				if err != nil {
					switch err {
					case courses.ErrReviewNotFound:
						writeError(w, http.StatusNotFound, "review_not_found", "Review not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			ar.Post("/moderation/reviews/{reviewID}/preview", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := courses.DecodePreviewStart(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Courses.StartModerationPreview(r.Context(), session.AccountID, chi.URLParam(r, "reviewID"), input.LessonID)
				if err != nil {
					switch err {
					case courses.ErrReviewNotFound:
						writeError(w, http.StatusNotFound, "review_not_found", "Review not found", nil)
					case courses.ErrDraftValidationFailed:
						writeError(w, http.StatusUnprocessableEntity, "draft_validation_failed", "Draft contains validation errors", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			ar.Get("/commerce/offers", requireRole("admin", deps, func(w http.ResponseWriter, r *http.Request) {
				view, err := deps.Commerce.ListOffers(r.Context())
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			ar.Post("/commerce/offers", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := commerce.DecodeOfferInput(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Commerce.CreateOffer(r.Context(), session.AccountID, input)
				if err != nil {
					switch err {
					case commerce.ErrInvalidOfferTarget:
						writeError(w, http.StatusUnprocessableEntity, "invalid_offer_target", "Invalid offer target", nil)
					case commerce.ErrTeacherContentCannotBePaid:
						writeError(w, http.StatusConflict, "teacher_content_cannot_be_paid", "Teacher content cannot be paid", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusCreated, view)
			}, deps)))
			ar.Put("/commerce/offers/{offerID}", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				input, err := commerce.DecodeUpdateOfferInput(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Commerce.UpdateOffer(r.Context(), chi.URLParam(r, "offerID"), input)
				if err != nil {
					switch err {
					case commerce.ErrInvalidOfferTarget:
						writeError(w, http.StatusUnprocessableEntity, "invalid_offer_target", "Invalid offer target", nil)
					case commerce.ErrOfferNotFound:
						writeError(w, http.StatusNotFound, "offer_not_found", "Offer not found", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			ar.Get("/commerce/purchase-requests", requireRole("admin", deps, func(w http.ResponseWriter, r *http.Request) {
				view, err := deps.Commerce.ListPurchaseRequests(r.Context())
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			ar.Post("/commerce/purchase-requests/{requestID}/decline", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				view, err := deps.Commerce.DeclinePurchaseRequest(r.Context(), chi.URLParam(r, "requestID"), session.AccountID)
				if err != nil {
					switch err {
					case commerce.ErrPurchaseRequestNotFound:
						writeError(w, http.StatusNotFound, "purchase_request_not_found", "Purchase request not found", nil)
					case commerce.ErrPurchaseRequestAlreadyResolved:
						writeError(w, http.StatusConflict, "purchase_request_already_resolved", "Purchase request already resolved", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			ar.Get("/commerce/orders", requireRole("admin", deps, func(w http.ResponseWriter, r *http.Request) {
				view, err := deps.Commerce.ListOrders(r.Context(), r.URL.Query().Get("status"), r.URL.Query().Get("student_id"))
				if err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, view)
			}))
			ar.Post("/commerce/orders/manual", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := commerce.DecodeManualOrderInput(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Commerce.CreateManualOrder(r.Context(), session.AccountID, input)
				if err != nil {
					switch err {
					case commerce.ErrOfferNotFound:
						writeError(w, http.StatusNotFound, "offer_not_found", "Offer not found", nil)
					case commerce.ErrOfferNotActive:
						writeError(w, http.StatusConflict, "offer_not_active", "Offer not active", nil)
					case commerce.ErrOrderAlreadyPendingForTarget:
						writeError(w, http.StatusConflict, "order_already_pending_for_target", "Order already pending for target", nil)
					case commerce.ErrPurchaseRequestOfferMismatch:
						writeError(w, http.StatusConflict, "purchase_request_offer_mismatch", "Purchase request offer mismatch", nil)
					case commerce.ErrPurchaseRequestNotFound:
						writeError(w, http.StatusNotFound, "purchase_request_not_found", "Purchase request not found", nil)
					case commerce.ErrPurchaseRequestAlreadyResolved:
						writeError(w, http.StatusConflict, "purchase_request_already_resolved", "Purchase request already resolved", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusCreated, view)
			}, deps)))
			ar.Post("/commerce/orders/{orderID}/payments/manual-confirm", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				idempotencyKey := r.Header.Get("Idempotency-Key")
				if idempotencyKey == "" {
					writeError(w, http.StatusBadRequest, "bad_request", "Missing Idempotency-Key", nil)
					return
				}
				input, err := commerce.DecodeManualConfirmInput(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				if strings.TrimSpace(input.ExternalReference) == "" {
					writeError(w, http.StatusBadRequest, "bad_request", "Missing external_reference", nil)
					return
				}
				view, err := deps.Commerce.ManualConfirm(r.Context(), chi.URLParam(r, "orderID"), session.AccountID, idempotencyKey, input)
				if err != nil {
					switch err {
					case commerce.ErrOrderNotFound:
						writeError(w, http.StatusNotFound, "order_not_found", "Order not found", nil)
					case commerce.ErrPaymentAlreadyConfirmed:
						writeError(w, http.StatusConflict, "payment_already_confirmed", "Payment already confirmed", nil)
					case commerce.ErrManualPaymentMismatch:
						writeError(w, http.StatusConflict, "manual_payment_mismatch", "Manual payment mismatch", nil)
					case commerce.ErrEntitlementAlreadyActive:
						writeError(w, http.StatusConflict, "entitlement_already_active", "Entitlement already active", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			ar.Post("/commerce/entitlements/grants", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				input, err := commerce.DecodeComplimentaryGrantInput(r)
				if err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Commerce.ComplimentaryGrant(r.Context(), session.AccountID, input)
				if err != nil {
					switch err {
					case commerce.ErrInvalidStudentID:
						writeError(w, http.StatusUnprocessableEntity, "invalid_student_id", "Student id must be valid", nil)
					case commerce.ErrInvalidOfferTarget:
						writeError(w, http.StatusUnprocessableEntity, "invalid_offer_target", "Invalid entitlement target", nil)
					case commerce.ErrTeacherContentCannotBePaid:
						writeError(w, http.StatusConflict, "teacher_content_cannot_be_paid", "Teacher content cannot be paid", nil)
					case commerce.ErrEntitlementAlreadyActive:
						writeError(w, http.StatusConflict, "entitlement_already_active", "Entitlement already active", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusCreated, view)
			}, deps)))
			ar.Post("/commerce/entitlements/{entitlementID}/revoke", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				view, err := deps.Commerce.RevokeEntitlement(r.Context(), chi.URLParam(r, "entitlementID"))
				if err != nil {
					switch err {
					case commerce.ErrEntitlementNotFound:
						writeError(w, http.StatusNotFound, "entitlement_not_found", "Entitlement not found", nil)
					case commerce.ErrEntitlementAlreadyResolved:
						writeError(w, http.StatusConflict, "entitlement_already_resolved", "Entitlement already resolved", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			ar.Post("/moderation/reviews/{reviewID}/approve", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				var body struct {
					Comment *string `json:"comment"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Courses.ApproveReview(r.Context(), chi.URLParam(r, "reviewID"), session.AccountID, body.Comment)
				if err != nil {
					switch err {
					case courses.ErrReviewNotFound:
						writeError(w, http.StatusNotFound, "review_not_found", "Review not found", nil)
					case courses.ErrReviewAlreadyResolved:
						writeError(w, http.StatusConflict, "review_already_resolved", "Review already resolved", nil)
					case courses.ErrCourseNotPublishable:
						writeError(w, http.StatusUnprocessableEntity, "course_not_publishable", "Course cannot be published", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			ar.Post("/moderation/reviews/{reviewID}/reject", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				var body struct {
					Comment *string `json:"comment"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
					return
				}
				view, err := deps.Courses.RejectReview(r.Context(), chi.URLParam(r, "reviewID"), session.AccountID, body.Comment)
				if err != nil {
					switch err {
					case courses.ErrReviewNotFound:
						writeError(w, http.StatusNotFound, "review_not_found", "Review not found", nil)
					case courses.ErrReviewAlreadyResolved:
						writeError(w, http.StatusConflict, "review_already_resolved", "Review already resolved", nil)
					default:
						writeInternalError(w)
					}
					return
				}
				writeJSON(w, http.StatusOK, view)
			}, deps)))
			ar.Get("/profile", requireRole("admin", deps, basicProfileGetHandler("admin", deps)))
			ar.Put("/profile", requireRole("admin", deps, requireCSRF(basicProfilePutHandler("admin", deps), deps)))
			ar.Post("/users/{userID}/block", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				session, _ := sessionFromContext(r.Context())
				userID := chi.URLParam(r, "userID")
				if userID == session.AccountID {
					writeError(w, http.StatusConflict, "cannot_block_self", "Admin cannot block self", nil)
					return
				}
				if err := deps.Identity.BlockUser(r.Context(), userID); err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{
					"account_id":       userID,
					"status":           "blocked",
					"sessions_revoked": true,
				})
			}, deps)))
			ar.Post("/users/{userID}/unblock", requireRole("admin", deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
				userID := chi.URLParam(r, "userID")
				if err := deps.Identity.UnblockUser(r.Context(), userID); err != nil {
					writeInternalError(w)
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{
					"account_id": userID,
					"status":     "active",
				})
			}, deps)))
		})

		r.Post("/preview-sessions/{previewSessionID}/next", requireAnyRole([]string{"teacher", "admin"}, deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
			session, _ := sessionFromContext(r.Context())
			var body struct {
				StateVersion   int64  `json:"state_version"`
				ExpectedNodeID string `json:"expected_node_id"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
				return
			}
			view, err := deps.Courses.PreviewNext(r.Context(), session.Role, session.AccountID, chi.URLParam(r, "previewSessionID"), body.StateVersion, body.ExpectedNodeID)
			if err != nil {
				switch err {
				case courses.ErrPreviewSessionNotFound:
					writeError(w, http.StatusNotFound, "preview_session_not_found", "Preview session not found", nil)
				case courses.ErrPreviewStateConflict:
					writeError(w, http.StatusConflict, "preview_session_state_conflict", "Preview session state conflict", nil)
				case courses.ErrInvalidPreviewAction:
					writeError(w, http.StatusConflict, "invalid_preview_action", "Invalid preview action", nil)
				case courses.ErrPreviewEvaluationUnavailable:
					writeError(w, http.StatusServiceUnavailable, "llm_temporarily_unavailable", "LLM is temporarily unavailable", nil)
				default:
					writeInternalError(w)
				}
				return
			}
			writeJSON(w, http.StatusOK, view)
		}, deps)))
		r.Get("/preview-sessions/{previewSessionID}", requireAnyRole([]string{"teacher", "admin"}, deps, func(w http.ResponseWriter, r *http.Request) {
			session, _ := sessionFromContext(r.Context())
			view, err := deps.Courses.PreviewSession(r.Context(), session.Role, session.AccountID, chi.URLParam(r, "previewSessionID"))
			if err != nil {
				switch err {
				case courses.ErrPreviewSessionNotFound:
					writeError(w, http.StatusNotFound, "preview_session_not_found", "Preview session not found", nil)
				default:
					writeInternalError(w)
				}
				return
			}
			writeJSON(w, http.StatusOK, view)
		}))
		r.Post("/preview-sessions/{previewSessionID}/answer", requireAnyRole([]string{"teacher", "admin"}, deps, requireCSRF(func(w http.ResponseWriter, r *http.Request) {
			session, _ := sessionFromContext(r.Context())
			var body struct {
				StateVersion int64          `json:"state_version"`
				NodeID       string         `json:"node_id"`
				Answer       map[string]any `json:"answer"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
				return
			}
			view, err := deps.Courses.PreviewAnswer(r.Context(), session.Role, session.AccountID, chi.URLParam(r, "previewSessionID"), body.StateVersion, body.NodeID, body.Answer)
			if err != nil {
				switch err {
				case courses.ErrPreviewSessionNotFound:
					writeError(w, http.StatusNotFound, "preview_session_not_found", "Preview session not found", nil)
				case courses.ErrPreviewStateConflict:
					writeError(w, http.StatusConflict, "preview_session_state_conflict", "Preview session state conflict", nil)
				case courses.ErrInvalidPreviewAction:
					writeError(w, http.StatusConflict, "invalid_preview_action", "Invalid preview action", nil)
				case courses.ErrPreviewEvaluationUnavailable:
					writeError(w, http.StatusServiceUnavailable, "llm_temporarily_unavailable", "LLM is temporarily unavailable", nil)
				default:
					writeInternalError(w)
				}
				return
			}
			writeJSON(w, http.StatusOK, view)
		}, deps)))
	})

	return router
}

func basicProfileGetHandler(role string, deps Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, _ := sessionFromContext(r.Context())
		view, err := deps.Profiles.GetBasic(r.Context(), role, session.AccountID)
		if err != nil {
			writeInternalError(w)
			return
		}
		writeJSON(w, http.StatusOK, view)
	}
}

func basicProfilePutHandler(role string, deps Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, _ := sessionFromContext(r.Context())
		input, err := profiles.DecodeUpdateProfile(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body", nil)
			return
		}
		view, err := deps.Profiles.UpdateBasic(r.Context(), role, session.AccountID, input)
		if err != nil {
			if errors.Is(err, profiles.ErrAssetNotOwned) {
				writeError(w, http.StatusUnprocessableEntity, "asset_not_owned", "Asset must belong to the same account", nil)
				return
			}
			writeInternalError(w)
			return
		}
		writeJSON(w, http.StatusOK, view)
	}
}
