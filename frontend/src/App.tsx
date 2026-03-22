import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import type { Role } from './api/types';
import { Suspense, lazy, type ReactNode } from 'react';

/* ===== Lazy-loaded pages ===== */

// Public
const Landing = lazy(() => import('./pages/public/Landing'));
const AuthPage = lazy(() => import('./pages/public/AuthPage'));
const RoleSelect = lazy(() => import('./pages/public/RoleSelect'));
const StudentOnboarding = lazy(() => import('./pages/public/StudentOnboarding'));
const TeacherOnboarding = lazy(() => import('./pages/public/TeacherOnboarding'));

// Student
const StudentCatalog = lazy(() => import('./pages/student/Catalog'));
const CourseTree = lazy(() => import('./pages/student/CourseTree'));
const LessonPlayer = lazy(() => import('./pages/student/LessonPlayer'));
const StudentProfile = lazy(() => import('./pages/student/Profile'));
const ClaimLink = lazy(() => import('./pages/student/ClaimLink'));

// Parent
const ParentDashboard = lazy(() => import('./pages/parent/Dashboard'));
const ChildProgress = lazy(() => import('./pages/parent/ChildProgress'));
const ParentProfile = lazy(() => import('./pages/parent/ParentProfile'));

// Teacher
const TeacherDashboard = lazy(() => import('./pages/teacher/TeacherDashboard'));
const CourseConstructor = lazy(() => import('./pages/teacher/CourseConstructor'));
const LessonConstructor = lazy(() => import('./pages/teacher/LessonConstructor'));
const StudentsProgress = lazy(() => import('./pages/teacher/StudentsProgress'));
const StudentDetail = lazy(() => import('./pages/teacher/StudentDetail'));
const TeacherProfile = lazy(() => import('./pages/teacher/TeacherProfile'));
const PreviewPlayer = lazy(() => import('./pages/teacher/PreviewPlayer'));

// Admin
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const AdminCourses = lazy(() => import('./pages/admin/AdminCourses'));
const AdminCourseEditor = lazy(() => import('./pages/admin/AdminCourseEditor'));
const AdminLessonEditor = lazy(() => import('./pages/admin/AdminLessonEditor'));
const AdminUsers = lazy(() => import('./pages/admin/AdminUsers'));
const Moderation = lazy(() => import('./pages/admin/Moderation'));
const Commerce = lazy(() => import('./pages/admin/Commerce'));
const AdminProfile = lazy(() => import('./pages/admin/AdminProfile'));

/* ===== Layouts ===== */
const PublicLayout = lazy(() => import('./components/layout/PublicLayout'));
const StudentLayout = lazy(() => import('./components/layout/StudentLayout'));
const ParentLayout = lazy(() => import('./components/layout/ParentLayout'));
const TeacherLayout = lazy(() => import('./components/layout/TeacherLayout'));
const AdminLayout = lazy(() => import('./components/layout/AdminLayout'));
const LessonLayout = lazy(() => import('./components/layout/LessonLayout'));

/* ===== Loading fallback ===== */
function PageLoader() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', fontFamily: 'var(--font-family)', fontSize: '1.2rem',
      color: 'var(--teal)', gap: '12px',
    }}>
      <span style={{ fontSize: '2rem', animation: 'spinShield 1s linear infinite', display: 'inline-block' }}>🛡️</span>
      Загрузка...
    </div>
  );
}

/* ===== Route guards ===== */
function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, session } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (!session?.authenticated) return <Navigate to={`/auth?return_to=${encodeURIComponent(location.pathname + location.search + location.hash)}`} replace />;
  return <>{children}</>;
}

function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { loading, session } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (!session?.authenticated) return <Navigate to={`/auth?return_to=${encodeURIComponent(location.pathname + location.search + location.hash)}`} replace />;
  if (session.onboarding.role_selection_required) {
    return <Navigate to={`/role-select?return_to=${encodeURIComponent(location.pathname + location.search + location.hash)}`} replace />;
  }
  if (session.user?.role !== role) return <Navigate to={roleHome(session.user!.role)} replace />;
  return <>{children}</>;
}

function RequireUnselected({ children }: { children: ReactNode }) {
  const { loading, session } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (!session?.authenticated) return <Navigate to={`/auth?return_to=${encodeURIComponent(location.pathname + location.search + location.hash)}`} replace />;
  if (!session.onboarding.role_selection_required) return <Navigate to={roleHome(session.user!.role)} replace />;
  return <>{children}</>;
}

function AuthRedirect() {
  const { loading, session } = useAuth();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const returnTo = params.get('return_to');
  if (loading) return <PageLoader />;
  if (session?.authenticated) {
    if (session.onboarding.role_selection_required) {
      const destination = returnTo ? `/role-select?return_to=${encodeURIComponent(returnTo)}` : '/role-select';
      return <Navigate to={destination} replace />;
    }
    if (session.user?.role === 'teacher' && session.onboarding.teacher_profile_required) return <Navigate to="/teacher-onboarding" replace />;
    return <Navigate to={roleHome(session.user!.role)} replace />;
  }
  return <Outlet />;
}

function roleHome(role: Role): string {
  switch (role) {
    case 'student': return '/student/courses';
    case 'parent': return '/parent';
    case 'teacher': return '/teacher';
    case 'admin': return '/admin';
    default: return '/';
  }
}

/* ===== Root redirect ===== */
function RootRedirect() {
  const { loading, session } = useAuth();
  if (loading) return <PageLoader />;
  if (!session?.authenticated) return <Landing />;
  if (session.onboarding.role_selection_required) return <Navigate to="/role-select" replace />;
  if (session.user?.role === 'teacher' && session.onboarding.teacher_profile_required) return <Navigate to="/teacher-onboarding" replace />;
  return <Navigate to={roleHome(session.user!.role)} replace />;
}

/* ===== App ===== */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Public */}
            <Route path="/" element={<RootRedirect />} />

            <Route element={<AuthRedirect />}>
              <Route element={<PublicLayout />}>
                <Route path="/auth" element={<AuthPage />} />
              </Route>
            </Route>

            <Route path="/role-select" element={
              <RequireAuth><RoleSelect /></RequireAuth>
            } />

            <Route path="/student-onboarding" element={
              <RequireRole role="student"><StudentOnboarding /></RequireRole>
            } />

            <Route path="/teacher-onboarding" element={
              <RequireAuth><TeacherOnboarding /></RequireAuth>
            } />

            {/* Claim links (need auth but any student role) */}
            <Route path="/claim/*" element={
              <RequireAuth><ClaimLink /></RequireAuth>
            } />

            {/* Student */}
            <Route path="/student" element={
              <RequireRole role="student"><StudentLayout /></RequireRole>
            }>
              <Route index element={<Navigate to="courses" replace />} />
              <Route path="courses" element={<StudentCatalog />} />
              <Route path="courses/:courseId" element={<CourseTree />} />
              <Route path="profile" element={<StudentProfile />} />
            </Route>

            {/* Lesson player (full screen, separate layout) */}
            <Route path="/student/courses/:courseId/lessons/:lessonId" element={
              <RequireRole role="student"><LessonLayout /></RequireRole>
            }>
              <Route index element={<LessonPlayer />} />
            </Route>

            {/* Parent */}
            <Route path="/parent" element={
              <RequireRole role="parent"><ParentLayout /></RequireRole>
            }>
              <Route index element={<ParentDashboard />} />
              <Route path="children/:studentId" element={<ChildProgress />} />
              <Route path="profile" element={<ParentProfile />} />
            </Route>

            {/* Teacher */}
            <Route path="/teacher" element={
              <RequireRole role="teacher"><TeacherLayout /></RequireRole>
            }>
              <Route index element={<TeacherDashboard />} />
              <Route path="courses/:courseId" element={<CourseConstructor />} />
              <Route path="courses/:courseId/lessons/:lessonId" element={<LessonConstructor />} />
              <Route path="courses/:courseId/students" element={<StudentsProgress />} />
              <Route path="courses/:courseId/students/:studentId" element={<StudentDetail />} />
              <Route path="profile" element={<TeacherProfile />} />
            </Route>

            {/* Teacher preview (full screen) */}
            <Route path="/teacher/preview/:previewSessionId" element={
              <RequireRole role="teacher"><PreviewPlayer /></RequireRole>
            } />

            {/* Admin */}
            <Route path="/admin" element={
              <RequireRole role="admin"><AdminLayout /></RequireRole>
            }>
              <Route index element={<AdminDashboard />} />
              <Route path="courses" element={<AdminCourses />} />
              <Route path="courses/:courseId" element={<AdminCourseEditor />} />
              <Route path="courses/:courseId/lessons/:lessonId" element={<AdminLessonEditor />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="moderation" element={<Moderation />} />
              <Route path="commerce" element={<Commerce />} />
              <Route path="profile" element={<AdminProfile />} />
            </Route>

            {/* Admin preview (full screen) */}
            <Route path="/admin/preview/:previewSessionId" element={
              <RequireRole role="admin"><PreviewPlayer /></RequireRole>
            } />

            {/* 404 */}
            <Route path="*" element={
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', minHeight: '100vh', gap: '16px',
                fontFamily: 'var(--font-family)',
              }}>
                <span style={{ fontSize: '4rem' }}>🔍</span>
                <h1 style={{ fontSize: '2rem', fontWeight: 800 }}>404</h1>
                <p>Страница не найдена</p>
                <a href="/" style={{
                  background: 'var(--orange)', color: 'white', padding: '12px 24px',
                  borderRadius: '12px', border: '3px solid var(--dark)',
                  boxShadow: '5px 5px 0 var(--dark)', fontWeight: 700,
                  textDecoration: 'none', textTransform: 'uppercase',
                }}>На главную</a>
              </div>
            } />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
