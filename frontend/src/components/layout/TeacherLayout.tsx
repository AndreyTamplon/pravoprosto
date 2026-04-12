import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { BrandLogo, ImpersonationBanner } from '../ui';
import styles from './TeacherLayout.module.css';

export default function TeacherLayout() {
  const { logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const navLinkCls = ({ isActive }: { isActive: boolean }) =>
    [styles.navLink, isActive ? styles.navLinkActive : '']
      .filter(Boolean)
      .join(' ');

  const bottomNavLinkCls = ({ isActive }: { isActive: boolean }) =>
    [styles.bottomNavLink, isActive ? styles.bottomNavLinkActive : '']
      .filter(Boolean)
      .join(' ');

  const navItems = (
    <>
      <NavLink to="/teacher" end className={navLinkCls} onClick={() => setMenuOpen(false)}>
        <span className={styles.navIcon}>📖</span>
        Мои курсы
      </NavLink>
      <NavLink to="/teacher/profile" className={navLinkCls} onClick={() => setMenuOpen(false)}>
        <span className={styles.navIcon}>👤</span>
        Профиль
      </NavLink>
    </>
  );

  return (
    <div className={styles.layout}>
      {/* Desktop sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <BrandLogo size="sm" className={styles.logoImage} />
        </div>
        <div className={styles.roleBadge}>Учитель</div>
        <nav className={styles.nav}>{navItems}</nav>
        <button className={styles.logoutBtn} onClick={logout} type="button">
          Выйти
        </button>
      </aside>

      <div className={styles.main}>
        {/* Mobile header */}
        <div className={styles.mobileHeader}>
          <button
            className={styles.hamburger}
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            type="button"
          >
            ☰
          </button>
          <span>SmartGo School</span>
          <span style={{ width: 24 }} />
        </div>

        <ImpersonationBanner />
        <div className={styles.content}>
          <Outlet />
        </div>
      </div>

      {/* Mobile bottom nav */}
      <nav className={styles.bottomNav}>
        <div className={styles.bottomNavInner}>
          <NavLink to="/teacher" end className={bottomNavLinkCls}>
            <span className={styles.bottomNavIcon}>📖</span>
            Курсы
          </NavLink>
          <NavLink to="/teacher/profile" className={bottomNavLinkCls}>
            <span className={styles.bottomNavIcon}>👤</span>
            Профиль
          </NavLink>
        </div>
      </nav>

      {/* Mobile drawer overlay */}
      <div
        className={`${styles.mobileOverlay} ${menuOpen ? styles.mobileOverlayOpen : ''}`}
        onClick={() => setMenuOpen(false)}
      />

      {/* Mobile drawer sidebar */}
      <aside
        className={`${styles.mobileSidebar} ${menuOpen ? styles.mobileSidebarOpen : ''}`}
      >
        <button
          className={styles.mobileCloseBtn}
          onClick={() => setMenuOpen(false)}
          aria-label="Close menu"
          type="button"
        >
          ✕
        </button>
        <div className={styles.logo}>Право Просто</div>
        <div className={styles.roleBadge}>Учитель</div>
        <nav className={styles.nav}>{navItems}</nav>
        <button className={styles.logoutBtn} onClick={logout} type="button">
          Выйти
        </button>
      </aside>
    </div>
  );
}
