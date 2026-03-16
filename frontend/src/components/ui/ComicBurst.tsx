import type { ReactNode } from 'react';
import styles from './ComicBurst.module.css';

interface ComicBurstProps {
  children: ReactNode;
  className?: string;
}

export function ComicBurst({ children, className }: ComicBurstProps) {
  const cls = [styles.burst, className ?? ''].filter(Boolean).join(' ');

  return <span className={cls}>{children}</span>;
}
