import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import styles from './ParentLayout.module.css';

export default function ParentLayout() {
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
      <NavLink to="/parent" end className={navLinkCls} onClick={() => setMenuOpen(false)}>
        <span className={styles.navIcon}>👨‍👧‍👦</span>
        Дети
      </NavLink>
      <NavLink to="/parent/profile" className={navLinkCls} onClick={() => setMenuOpen(false)}>
        <span className={styles.navIcon}>👤</span>
        Профиль
      </NavLink>
    </>
  );

  return (
    <div className={styles.layout}>
      {/* Desktop sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.logo}>Право Просто</div>
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
          <span>Право Просто</span>
          <span style={{ width: 24 }} />
        </div>

        <div className={styles.content}>
          <Outlet />
        </div>
      </div>

      {/* Mobile bottom nav */}
      <nav className={styles.bottomNav}>
        <div className={styles.bottomNavInner}>
          <NavLink to="/parent" end className={bottomNavLinkCls}>
            <span className={styles.bottomNavIcon}>👨‍👧‍👦</span>
            Дети
          </NavLink>
          <NavLink to="/parent/profile" className={bottomNavLinkCls}>
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
        <nav className={styles.nav}>{navItems}</nav>
        <button className={styles.logoutBtn} onClick={logout} type="button">
          Выйти
        </button>
      </aside>
    </div>
  );
}
