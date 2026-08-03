export type WebAccessRuntimeActionId =
  | 'open-curator'
  | 'curator-on'
  | 'curator-off'
  | 'curator-summary-review'
  | 'google-account'
  | 'stored-results';

const WEB_ACCESS_RUNTIME_COMMAND_NAMES: Record<WebAccessRuntimeActionId, string> = {
  'curator-off': 'curator',
  'curator-on': 'curator',
  'curator-summary-review': 'curator',
  'google-account': 'google-account',
  'open-curator': 'websearch',
  'stored-results': 'search',
};

export const webAccessRuntimeCommandName = (
  action: WebAccessRuntimeActionId,
): string => WEB_ACCESS_RUNTIME_COMMAND_NAMES[action];

export const buildWebAccessRuntimeCommand = (
  action: WebAccessRuntimeActionId,
  options: { query?: string } = {},
): string => {
  const name = webAccessRuntimeCommandName(action);
  if (action === 'curator-on') return `${name} on`;
  if (action === 'curator-off') return `${name} off`;
  if (action === 'curator-summary-review') return `${name} summary-review`;
  if (action !== 'open-curator') return name;
  const query = options.query?.trim() ?? '';
  return query ? `${name} ${query}` : name;
};
