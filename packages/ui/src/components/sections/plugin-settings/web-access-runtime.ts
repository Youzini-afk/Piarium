export type WebAccessRuntimeActionId =
  | 'open-curator'
  | 'google-account'
  | 'stored-results';

const WEB_ACCESS_RUNTIME_COMMAND_NAMES: Record<WebAccessRuntimeActionId, string> = {
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
  if (action !== 'open-curator') return name;
  const query = options.query?.trim() ?? '';
  return query ? `${name} ${query}` : name;
};
