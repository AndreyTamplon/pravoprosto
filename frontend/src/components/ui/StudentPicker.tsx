import { useState, useRef, useEffect, useCallback } from 'react';
import { getAdminUsers } from '../../api/client';
import type { AdminUser } from '../../api/types';
import styles from './StudentPicker.module.css';

interface StudentPickerProps {
  label?: string;
  value: string;
  displayValue?: string;
  onChange: (studentId: string, displayName: string) => void;
  placeholder?: string;
}

export function StudentPicker({ label, value, displayValue, onChange, placeholder = 'Начните вводить имя…' }: StudentPickerProps) {
  const [query, setQuery] = useState(displayValue ?? '');
  const [results, setResults] = useState<AdminUser[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const users = await getAdminUsers({ role: 'student', q });
      setResults(users);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleInput(text: string) {
    setQuery(text);
    if (value) {
      onChange('', '');
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(text), 300);
    setOpen(true);
  }

  function handleSelect(user: AdminUser) {
    onChange(user.account_id, user.display_name);
    setQuery(user.display_name);
    setOpen(false);
    setResults([]);
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (displayValue && !query) setQuery(displayValue);
  }, [displayValue]);

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      {label && <label className={styles.label}>{label}</label>}
      <input
        className={styles.input}
        value={query}
        onChange={e => handleInput(e.target.value)}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {value && <div className={styles.selected}>✓ {query}</div>}
      {open && (results.length > 0 || loading) && (
        <div className={styles.dropdown}>
          {loading && <div className={styles.dropdownLoading}>Поиск…</div>}
          {results.map(u => (
            <button
              key={u.account_id}
              className={styles.item}
              type="button"
              onMouseDown={e => { e.preventDefault(); handleSelect(u); }}
            >
              <span className={styles.itemName}>{u.display_name}</span>
              {u.email && <span className={styles.itemEmail}>{u.email}</span>}
            </button>
          ))}
          {!loading && results.length === 0 && query.length >= 2 && (
            <div className={styles.dropdownEmpty}>Ничего не найдено</div>
          )}
        </div>
      )}
    </div>
  );
}
