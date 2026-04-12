import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { BrandLogo } from '../ui';
import styles from './AdminLayout.module.css';

export default function AdminLayout() {
  const { logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const navLinkCls = ({ isActive }: { isActive: boolean }) =>
    [styles.navLink, isActive ? styles.navLinkActive : '']
      .filter(Boolean)
      .join(' ');

  const navItems = (
    <>
      <NavLink
        to="/admin"
        end
        className={navLinkCls}
        onClick={() => setMenuOpen(false)}
      >
        <span className={styles.navIcon}>📊</span>
        Дашборд
      </NavLink>
      <NavLink
        to="/admin/courses"
        className={navLinkCls}
        onClick={() => setMenuOpen(false)}
      >
        <span className={styles.navIcon}>📚</span>
        Курсы
      </NavLink>
      <NavLink
        to="/admin/moderation"
        className={navLinkCls}
        onClick={() => setMenuOpen(false)}
      >
        <span className={styles.navIcon}>🔍</span>
        Модерация
      </NavLink>
      <NavLink
        to="/admin/commerce"
        className={navLinkCls}
        onClick={() => setMenuOpen(false)}
      >
        <span className={styles.navIcon}>💰</span>
        Коммерция
      </NavLink>
      <div className={styles.divider} />
      <NavLink
        to="/admin/users"
        className={navLinkCls}
        onClick={() => setMenuOpen(false)}
      >
        <span className={styles.navIcon}>👥</span>
        Пользователи
      </NavLink>
      <NavLink
        to="/admin/profile"
        className={navLinkCls}
        onClick={() => setMenuOpen(false)}
      >
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
        <div className={styles.roleBadge}>Администратор</div>
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

        <div className={styles.content}>
          <Outlet />
        </div>
      </div>

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
        <div className={styles.logo}>
          <BrandLogo size="sm" className={styles.logoImage} />
        </div>
        <div className={styles.roleBadge}>Администратор</div>
        <nav className={styles.nav}>{navItems}</nav>
        <button className={styles.logoutBtn} onClick={logout} type="button">
          Выйти
        </button>
      </aside>
    </div>
  );
}
