import type { ReactNode } from 'react';
import { Outlet, Link } from 'react-router-dom';
import { BrandLogo } from '../ui';
import styles from './PublicLayout.module.css';

interface PublicLayoutProps {
  showHeader?: boolean;
  headerActions?: ReactNode;
}

export default function PublicLayout({
  showHeader = true,
  headerActions,
}: PublicLayoutProps) {
  return (
    <div className={styles.layout}>
      {showHeader && (
        <header className={styles.header}>
          <Link to="/" className={styles.logo} aria-label="SmartGo School">
            <BrandLogo size="sm" className={styles.logoImage} />
          </Link>
          {headerActions && (
            <div className={styles.headerActions}>{headerActions}</div>
          )}
        </header>
      )}
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
