import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import styles from './TeacherLayout.module.css';

export default function TeacherLayout() {
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
        <div className={styles.roleBadge}>Учитель</div>
        <nav className={styles.nav}>
          <NavLink to="/teacher" end className={navLinkCls}>
            <span className={styles.navIcon}>📖</span>
            Мои курсы
          </NavLink>
          <NavLink to="/teacher/profile" className={navLinkCls}>
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
    </div>
  );
}
