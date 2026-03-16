import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'outline' | 'teal' | 'dark';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  loading?: boolean;
  full?: boolean;
  fullWidth?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  children,
  className,
  disabled,
  loading,
  full,
  fullWidth,
  ...rest
}: ButtonProps) {
  const cls = [
    styles.btn,
    styles[variant],
    styles[size],
    styles.uppercase,
    (full || fullWidth) ? styles.full : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return (
    <button
      className={cls}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <span className={styles.spinner} />}
      {children}
    </button>
  );
}
