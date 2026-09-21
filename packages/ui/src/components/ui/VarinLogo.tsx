import React from 'react';
import { useI18n } from '@/lib/i18n';
import { VARIN_MARK_PATHS, VARIN_MARK_SECONDARY_OPACITY, VARIN_MARK_VIEWBOX } from './varin-mark';

interface VarinLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
  /** Use when a surrounding label already names the mark. */
  decorative?: boolean;
}

export const VarinLogo: React.FC<VarinLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
  decorative = false,
}) => {
  const { t } = useI18n();
  const compact = Math.min(width, height) <= 24;

  return (
    <svg
      width={width}
      height={height}
      viewBox={VARIN_MARK_VIEWBOX}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      {...(decorative
        ? { 'aria-hidden': true, focusable: false }
        : { role: 'img', 'aria-label': t('varinLogo.aria.logo') })}
    >
      {isAnimated ? (
        <style>{`@keyframes varin-logo-glow{0%,100%{filter:drop-shadow(0 0 0 transparent)}50%{filter:drop-shadow(0 0 4px currentColor)}}.varin-logo-glow{animation:varin-logo-glow 1.8s ease-in-out infinite}@media (prefers-reduced-motion:reduce){.varin-logo-glow{animation:none}}`}</style>
      ) : null}
      <g className={isAnimated ? 'varin-logo-glow' : undefined}>
        {VARIN_MARK_PATHS.map((path, index) => (
          <path key={path} d={path} opacity={index === 0 || compact ? 1 : VARIN_MARK_SECONDARY_OPACITY} />
        ))}
      </g>
    </svg>
  );
};
