import { useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import styles from './Input.module.css';

/* ===== Input ===== */
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className, ...rest }: InputProps) {
  const generatedId = useId();
  const controlId = rest.id ?? generatedId;
  const wrapperCls = [
    styles.wrapper,
    error ? styles.hasError : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperCls}>
      {label && <label className={styles.label} htmlFor={controlId}>{label}</label>}
      <input className={styles.input} id={controlId} {...rest} />
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}

/* ===== Textarea ===== */
interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function Textarea({ label, error, className, ...rest }: TextareaProps) {
  const generatedId = useId();
  const controlId = rest.id ?? generatedId;
  const wrapperCls = [
    styles.wrapper,
    error ? styles.hasError : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperCls}>
      {label && <label className={styles.label} htmlFor={controlId}>{label}</label>}
      <textarea className={styles.textarea} id={controlId} {...rest} />
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}

/* ===== Select ===== */
interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  children: React.ReactNode;
}

export function Select({ label, error, className, children, ...rest }: SelectProps) {
  const generatedId = useId();
  const controlId = rest.id ?? generatedId;
  const wrapperCls = [
    styles.wrapper,
    error ? styles.hasError : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperCls}>
      {label && <label className={styles.label} htmlFor={controlId}>{label}</label>}
      <select className={styles.input} id={controlId} {...rest}>{children}</select>
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
