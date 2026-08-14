import type { IconName } from '@/components/icon/icons';
import {
  getSettingsPageRegistrations,
  subscribeSettingsPageRegistrations,
} from './surface-registry';
import type {
  SettingsPageMeta,
  SettingsPageSlug,
} from './page-types';

export type {
  SettingsPageGroup,
  SettingsPageImplementation,
  SettingsPageMeta,
  SettingsPageRegistration,
  SettingsPageSlug,
  SettingsRuntimeContext,
} from './page-types';

export function getSettingsPageMetadata(): SettingsPageMeta[] {
  return getSettingsPageRegistrations().map((registration) => registration.meta);
}

export { subscribeSettingsPageRegistrations };

export function getSettingsPageMeta(slug: string): SettingsPageMeta | null {
  const normalized = slug.trim().toLowerCase();
  return getSettingsPageMetadata().find((page) => page.slug === normalized) ?? null;
}

export function resolveSettingsSlug(value: string | null | undefined): SettingsPageSlug {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return 'home';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) return 'home';
  const registrations = getSettingsPageRegistrations();
  if (registrations.length === 0) return normalized;
  return registrations.some((registration) => registration.meta.slug === normalized) ? normalized : 'home';
}

export function getSettingsNavIcon(slug: SettingsPageSlug): IconName | null {
  const icon = getSettingsPageMeta(slug)?.icon;
  return icon && icon !== 'mcp' ? icon : null;
}
