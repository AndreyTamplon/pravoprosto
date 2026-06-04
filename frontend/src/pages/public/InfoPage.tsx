import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BrandLogo } from '../../components/ui';
import styles from './InfoPage.module.css';

/** Shared chrome for the public Support / Offer / Privacy pages. */
export function InfoPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/');
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.topbar}>
        <Link to="/" className={styles.logoLink} aria-label="SmartGo School — на главную">
          <BrandLogo size="sm" />
        </Link>
        <button type="button" className={styles.backBtn} onClick={handleBack}>
          ← Назад
        </button>
      </div>

      <div className={styles.container}>
        <div className={styles.card}>
          <h1 className={styles.title}>{title}</h1>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

/** A block of a legal document — rendered in order. */
export type DocBlock =
  | { type: 'h'; text: string }
  | { type: 'p'; text: string }
  | { type: 'list'; ordered?: boolean; items: string[] };

export function DocBlocks({ blocks }: { blocks: DocBlock[] }) {
  return (
    <div className={styles.doc}>
      {blocks.map((block, i) => {
        if (block.type === 'h') return <h2 key={i}>{block.text}</h2>;
        if (block.type === 'p') return <p key={i}>{block.text}</p>;
        const items = block.items.map((item, j) => <li key={j}>{item}</li>);
        return block.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      })}
    </div>
  );
}

/** Shared cross-links shown at the bottom of every info page. */
export function DocLinks({ exclude }: { exclude: 'support' | 'offer' | 'privacy' }) {
  const links = [
    { key: 'support', to: '/support', icon: '💬', label: 'Поддержка и FAQ' },
    { key: 'offer', to: '/offer', icon: '📄', label: 'Публичная оферта' },
    { key: 'privacy', to: '/privacy', icon: '🔒', label: 'Политика конфиденциальности' },
  ] as const;
  return (
    <div className={styles.docLinks}>
      {links
        .filter((l) => l.key !== exclude)
        .map((l) => (
          <Link key={l.key} to={l.to} className={styles.docLink}>
            <span aria-hidden>{l.icon}</span>
            {l.label}
          </Link>
        ))}
    </div>
  );
}

export { styles as infoStyles };
