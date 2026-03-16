import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import styles from './ParentLayout.module.css';

export default function ParentLayout() {
  const { logout } = useAuth();

  const navLinkCls = ({ isActive }: { isActive: boolean }) =>
    [styles.navLink, isActive ? styles.navLinkActive : '']
      .filter(Boolean)
      .join(' ');

  const bottomNavLinkCls = ({ isActive }: { isActive: boolean }) =>
    [styles.bottomNavLink, isActive ? styles.bottomNavLinkActive : '']
      .filter(Boolean)
      .join(' ');

  return (
    <div className={styles.layout}>
      {/* Desktop sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.logo}>Право Просто</div>
        <nav className={styles.nav}>
          <NavLink to="/parent" end className={navLinkCls}>
            <span className={styles.navIcon}>👨‍👧‍👦</span>
            Дети
          </NavLink>
          <NavLink to="/parent/profile" className={navLinkCls}>
            <span className={styles.navIcon}>👤</span>
            Профиль
          </NavLink>
        </nav>
        <button className={styles.logoutBtn} onClick={logout} type="button">
          Выйти
        </button>
      </aside>

      <div className={styles.main}>
        {/* Mobile header */}
        <div className={styles.mobileHeader}>Право Просто</div>

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
    </div>
  );
}
