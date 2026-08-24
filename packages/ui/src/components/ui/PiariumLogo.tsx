import React, { useMemo } from 'react';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import {
  LOGO_LEFT_FACE_CELLS,
  LOGO_LEFT_FACE_PATH,
  LOGO_PROJECTED_MARK_PATH,
  LOGO_RIGHT_FACE_CELLS,
  LOGO_RIGHT_FACE_PATH,
  LOGO_TOP_FACE_PATH,
  LOGO_VIEWBOX,
  leftFaceCellOpacity,
  rightFaceCellOpacity,
} from './piarium-logo-geometry';

interface PiariumLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
  /**
   * Suppresses the accessible name so a decorative instance does not announce itself. Use it when a
   * surrounding element already names the mark, as the splash does.
   */
  decorative?: boolean;
}

export const PiariumLogo: React.FC<PiariumLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
  decorative = false,
}) => {
  const { t } = useI18n();
  const themeContext = useOptionalThemeSystem();

  let isDark = true;
  if (themeContext) {
    isDark = themeContext.currentTheme.metadata.variant !== 'light';
  } else if (typeof window !== 'undefined') {
    isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  const strokeColor = useMemo(() => {
    if (themeContext) {
      return themeContext.currentTheme.colors.surface.foreground;
    }
    if (typeof window !== 'undefined') {
      const fromVars = getComputedStyle(document.documentElement).getPropertyValue('--splash-stroke').trim();
      if (fromVars) {
        return fromVars;
      }
    }
    return isDark ? 'white' : 'black';
  }, [themeContext, isDark]);

  const supportsColorMix = useMemo(() => {
    if (typeof window === 'undefined' || typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
      return false;
    }
    return CSS.supports('color', 'color-mix(in srgb, white 50%, transparent)');
  }, []);

  const fillColor = useMemo(() => {
    if (themeContext) {
      if (supportsColorMix) {
        return `color-mix(in srgb, ${strokeColor} 15%, transparent)`;
      }
      return isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
    }
    if (typeof window !== 'undefined') {
      const fromVars = getComputedStyle(document.documentElement).getPropertyValue('--splash-face-fill').trim();
      if (fromVars) {
        return fromVars;
      }
    }
    return isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
  }, [themeContext, supportsColorMix, strokeColor, isDark]);

  const cellHighlightColor = useMemo(() => {
    if (themeContext) {
      if (supportsColorMix) {
        return `color-mix(in srgb, ${strokeColor} 35%, transparent)`;
      }
      return isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.4)';
    }
    if (typeof window !== 'undefined') {
      const fromVars = getComputedStyle(document.documentElement).getPropertyValue('--splash-cell-fill').trim();
      if (fromVars) {
        return fromVars;
      }
    }
    return isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.4)';
  }, [themeContext, supportsColorMix, strokeColor, isDark]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={LOGO_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      {...(decorative
        ? { 'aria-hidden': true, focusable: false as unknown as boolean }
        : { role: 'img', 'aria-label': t('piariumLogo.aria.logo') })}
    >
      {isAnimated ? (
        <style>{`@keyframes piarium-logo-glow{0%,100%{filter:drop-shadow(0 0 0 transparent)}50%{filter:drop-shadow(0 0 4px var(--piarium-glow-color))}}.piarium-logo-glow{animation:piarium-logo-glow 1.8s ease-in-out infinite}@media (prefers-reduced-motion:reduce){.piarium-logo-glow{animation:none}}`}</style>
      ) : null}

      {/* Left face - base fill */}
      <path
        d={LOGO_LEFT_FACE_PATH}
        fill={fillColor}
      />

      {/* Left face - grid cells with varying opacity */}
      {LOGO_LEFT_FACE_CELLS.map((cell, i) => (
        <path
          key={`left-${i}`}
          d={cell.path}
          fill={cellHighlightColor}
          opacity={leftFaceCellOpacity(cell)}
        />
      ))}

      {/* Right face - base fill */}
      <path
        d={LOGO_RIGHT_FACE_PATH}
        fill={fillColor}
      />

      {/* Right face - grid cells with varying opacity */}
      {LOGO_RIGHT_FACE_CELLS.map((cell, i) => (
        <path
          key={`right-${i}`}
          d={cell.path}
          fill={cellHighlightColor}
          opacity={rightFaceCellOpacity(cell)}
        />
      ))}

      {/* Top face - the same subtle surface used by the startup cube. */}
      <path
        d={LOGO_TOP_FACE_PATH}
        fill={fillColor}
      />

      {/* Face outlines paint after the mosaic, matching the splash cube's inset edges. */}
      <g fill="none" stroke={strokeColor} strokeWidth="2" strokeLinejoin="round">
        <path d={LOGO_LEFT_FACE_PATH} />
        <path d={LOGO_RIGHT_FACE_PATH} />
        <path d={LOGO_TOP_FACE_PATH} />
      </g>

      {/* Piarium's π mark projected through the startup camera. */}
      <g
        opacity={1}
        className={isAnimated ? 'piarium-logo-glow' : undefined}
        style={isAnimated ? ({ '--piarium-glow-color': strokeColor } as React.CSSProperties) : undefined}
      >
        <path d={LOGO_PROJECTED_MARK_PATH} fill={strokeColor} />
      </g>
    </svg>
  );
};
