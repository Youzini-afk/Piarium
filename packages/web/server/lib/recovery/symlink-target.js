export const portableSymlinkTarget = (value, platform = process.platform) => (
  platform === 'win32' && typeof value === 'string' ? value.replaceAll('\\', '/') : value
);
