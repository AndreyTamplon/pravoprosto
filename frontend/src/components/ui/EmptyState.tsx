import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  emoji?: string;
  icon?: string;
  text?: string;
  title?: string;
  description?: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function EmptyState({
  emoji,
  icon,
  text,
  title,
  description,
  action,
  children,
  className,
}: EmptyStateProps) {
  const displayIcon = icon ?? emoji ?? '📭';
  const displayTitle = title ?? text ?? '';
  const cls = [styles.empty, className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <span className={styles.emoji}>{displayIcon}</span>
      {displayTitle && <p className={styles.text}>{displayTitle}</p>}
      {description && <p className={styles.description}>{description}</p>}
      {children && <div className={styles.action}>{children}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
