import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useApi } from '../../hooks/useApi';
import { getGameState } from '../../api/client';
import { Spinner, BrandLogo } from '../ui';
import styles from './StudentLayout.module.css';

export default function StudentLayout() {
  const { logout } = useAuth();
  const { data: game, loading } = useApi(getGameState, []);
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
      <NavLink to="/student/courses" className={navLinkCls} onClick={() => setMenuOpen(false)}>
        <span className={styles.navIcon}>📚</span>
        Курсы
      </NavLink>
      <NavLink to="/student/profile" className={navLinkCls} onClick={() => setMenuOpen(false)}>
        <span className={styles.navIcon}>👤</span>
        Профиль
      </NavLink>
    </>
  );

  return (
    <div className={styles.layout}>
      {/* Desktop left sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <BrandLogo size="sm" className={styles.logoImage} />
        </div>
        <nav className={styles.nav}>{navItems}</nav>
        <button className={styles.logoutBtn} onClick={logout} type="button">
          Выйти
        </button>
      </aside>

      {/* Center */}
      <div className={styles.main}>
        {/* Mobile top HUD */}
        <div className={styles.mobileHud}>
          <button
            className={styles.hamburger}
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            type="button"
          >
            ☰
          </button>
          <span style={{ fontWeight: 800, fontSize: '1rem' }}>SmartGo School</span>
          {game ? (
            <div className={styles.mobileStats}>
              <span className={`${styles.mobileStat} ${styles.mobileStatXp}`}>
                ★ {game.xp_total}
              </span>
              <span className={`${styles.mobileStat} ${styles.mobileStatStreak}`}>
                🔥 {game.current_streak_days}
              </span>
            </div>
          ) : (
            <span style={{ width: 24 }} />
          )}
        </div>

        <div className={styles.content}>
          <Outlet />
        </div>
      </div>

      {/* Desktop right sidebar */}
      <aside className={styles.rightBar}>
        {loading ? (
          <div className={styles.loadingWrap}>
            <Spinner />
          </div>
        ) : game ? (
          <>
            <div className={styles.widget}>
              <div className={styles.widgetTitle}>Серия</div>
              <div className={`${styles.widgetValue} ${styles.streakVal}`}>
                🔥 {game.current_streak_days} дн.
              </div>
              <div className={styles.widgetSub}>
                Лучшая: {game.best_streak_days} дн.
              </div>
            </div>

            <div className={styles.widget}>
              <div className={styles.widgetTitle}>Опыт</div>
              <div className={`${styles.widgetValue} ${styles.xpVal}`}>
                ★ {game.xp_total}
              </div>
              <div className={styles.widgetSub}>Уровень {game.level}</div>
            </div>

          </>
        ) : null}
      </aside>

      {/* Mobile bottom tab bar */}
      <nav className={styles.bottomNav}>
        <div className={styles.bottomNavInner}>
          <NavLink to="/student/courses" className={bottomNavLinkCls}>
            <span className={styles.bottomNavIcon}>📚</span>
            Курсы
          </NavLink>
          <NavLink to="/student/profile" className={bottomNavLinkCls}>
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
