import React from 'react';
import { PiariumSplash } from '@/components/ui/PiariumSplash';
import { useI18n } from '@/lib/i18n';
import { isInitialSplashPresent } from '@/lib/splash';

/**
 * The loading screen for the React gates that run during startup.
 *
 * Startup passes through several of these — the auth gate, the lazy application chunk — while the
 * pre-paint splash from `index.html` is still on screen. Each one used to paint its own cover, so a
 * slow start stacked identical marks and produced two fades against each other. While the pre-paint
 * splash is present this renders nothing and lets it keep the screen; once it has been removed, a
 * later gate (re-authentication, a runtime endpoint change) gets a real cover of its own.
 *
 * The check runs once per mount rather than as reactive state: the pre-paint splash is removed by the
 * app itself at a moment this component does not participate in, so there is nothing to subscribe to
 * and re-reading it would only risk a cover appearing mid-startup.
 */
export const ApplicationLoadingScreen: React.FC = () => {
  const { t } = useI18n();
  const [deferToInitialSplash] = React.useState(isInitialSplashPresent);

  if (deferToInitialSplash) return null;

  return <PiariumSplash mode="boot" label={t('splash.aria.loading')} />;
};
