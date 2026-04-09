import styles from './BrandLogo.module.css';

type BrandLogoVariant = 'logotype' | 'decorated' | 'onWhite';
type BrandLogoSize = 'sm' | 'md' | 'lg' | 'xl';

interface BrandLogoProps {
  variant?: BrandLogoVariant;
  size?: BrandLogoSize;
  className?: string;
  alt?: string;
}

const SRC_BY_VARIANT: Record<BrandLogoVariant, string> = {
  logotype: '/brand/smartgo-logotype.png',
  decorated: '/brand/smartgo-logo-decorated.png',
  onWhite: '/brand/smartgo-logo-on-white.png',
};

export function BrandLogo({
  variant = 'logotype',
  size = 'md',
  className = '',
  alt = 'SmartGo School',
}: BrandLogoProps) {
  return (
    <img
      src={SRC_BY_VARIANT[variant]}
      alt={alt}
      className={[styles.logo, styles[size], className].filter(Boolean).join(' ')}
      loading="eager"
      decoding="async"
    />
  );
}
