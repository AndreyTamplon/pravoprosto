import type { HTMLAttributes, ReactNode } from 'react';
import styles from './ComicPanel.module.css';

interface ComicPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  noPadding?: boolean;
  hoverable?: boolean;
  clickable?: boolean;
  flat?: boolean;
  size?: 'sm' | 'md';
  accent?: 'teal' | 'orange' | 'blue' | 'pink' | 'lime';
}

const accentMap: Record<string, string> = {
  teal: styles.accentTeal,
  orange: styles.accentOrange,
  blue: styles.accentBlue,
  pink: styles.accentPink,
  lime: styles.accentLime,
};

export function ComicPanel({
  children,
  className,
  noPadding,
  hoverable,
  clickable,
  flat,
  size,
  accent,
  ...rest
}: ComicPanelProps) {
  const cls = [
    styles.panel,
    noPadding ? styles.noPad : '',
    (hoverable || clickable) ? styles.clickable : '',
    flat ? styles.flat : '',
    size === 'sm' ? styles.panelSm : '',
    accent ? accentMap[accent] ?? '' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
