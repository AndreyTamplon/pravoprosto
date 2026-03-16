import styles from './Spinner.module.css';

type SpinnerSize = 'sm' | 'md' | 'lg';

interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
  text?: string;
}

export function Spinner({ size = 'md', className, text }: SpinnerProps) {
  const spinnerCls = [styles.spinner, styles[size], text ? '' : (className ?? '')]
    .filter(Boolean)
    .join(' ');

  if (text) {
    return (
      <div className={`${styles.wrap} ${className ?? ''}`}>
        <div className={spinnerCls} role="status" aria-label="Loading" />
        <span className={styles.text}>{text}</span>
      </div>
    );
  }

  return <div className={spinnerCls} role="status" aria-label="Loading" />;
}
