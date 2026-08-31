/**
 * @piarium/application-client is now the authoritative owner of RuntimeAPIs
 * and all application client DTOs. This file re-exports them for backward
 * compatibility with existing @piarium/ui/lib/api/types consumers.
 *
 * New code should import from @piarium/application-client directly.
 * This re-export will be removed once all consumers are migrated.
 */
export * from '@piarium/application-client';
