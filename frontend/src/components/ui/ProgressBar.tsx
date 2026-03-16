import s from './ProgressBar.module.css';

interface ProgressBarProps {
  value: number;
  max?: number;
  color?: 'teal' | 'orange' | 'lime' | 'blue' | 'pink';
  size?: 'sm' | 'md';
  height?: number;
  label?: string;
  showPct?: boolean;
  showLabel?: boolean;
  className?: string;
}

export function ProgressBar({
  value,
  max = 100,
  color = 'teal',
  size = 'md',
  height,
  label,
  showPct = false,
  showLabel = false,
  className = '',
}: ProgressBarProps) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;

  return (
    <div className={`${s.wrapper} ${className}`}>
      {(label || showPct) && (
        <div className={s.label}>
          {label && <span>{label}</span>}
          {showPct && <span>{pct}%</span>}
        </div>
      )}
      <div
        className={`${s.track} ${size === 'sm' ? s.trackSm : ''}`}
        style={height ? { height } : undefined}
      >
        <div className={`${s.fill} ${s[color]}`} style={{ width: `${pct}%` }} />
        {showLabel && (
          <span className={s.pctLabel}>{pct}%</span>
        )}
      </div>
    </div>
  );
}
