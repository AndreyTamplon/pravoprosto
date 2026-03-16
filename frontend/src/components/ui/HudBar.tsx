import { ProgressBar } from './ProgressBar';
import styles from './HudBar.module.css';

interface HudBarProps {
  onClose: () => void;
  progress: number;
  hearts: number;
  heartsMax: number;
  xp: number;
  streak: number;
}

export function HudBar({
  onClose,
  progress,
  hearts,
  heartsMax,
  xp,
  streak,
}: HudBarProps) {
  return (
    <div className={styles.hud}>
      <button
        className={styles.closeBtn}
        onClick={onClose}
        aria-label="Close"
        type="button"
      >
        ✕
      </button>

      <div className={styles.progressWrap}>
        <ProgressBar value={progress} size="sm" />
      </div>

      <div className={styles.stats}>
        <span className={`${styles.stat} ${styles.hearts}`}>
          ♥ {hearts}/{heartsMax}
        </span>
        <span className={`${styles.stat} ${styles.xp}`}>
          ★ {xp}
        </span>
        <span className={`${styles.stat} ${styles.streak}`}>
          🔥 {streak}
        </span>
      </div>
    </div>
  );
}
