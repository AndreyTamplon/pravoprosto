import type { ReactNode } from 'react';
import styles from './SpeechBubble.module.css';

type Direction = 'left' | 'right' | 'bottom';

interface SpeechBubbleProps {
  children: ReactNode;
  direction?: Direction;
  className?: string;
}

export function SpeechBubble({
  children,
  direction = 'bottom',
  className,
}: SpeechBubbleProps) {
  const cls = [styles.bubble, styles[direction], className ?? '']
    .filter(Boolean)
    .join(' ');

  return <div className={cls}>{children}</div>;
}
