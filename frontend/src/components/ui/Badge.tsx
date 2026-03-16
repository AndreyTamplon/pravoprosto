import type { ReactNode } from 'react';
import styles from './Badge.module.css';

type BadgeColor = 'teal' | 'blue' | 'orange' | 'pink' | 'lime' | 'red' | 'gray' | 'yellow' | 'dark';

interface BadgeProps {
  color?: BadgeColor;
  variant?: BadgeColor;
  children: ReactNode;
  className?: string;
}

export function Badge({ color, variant, children, className }: BadgeProps) {
  const c = color ?? variant ?? 'gray';
  const cls = [styles.badge, styles[c], className ?? ''].filter(Boolean).join(' ');
  return <span className={cls}>{children}</span>;
}
