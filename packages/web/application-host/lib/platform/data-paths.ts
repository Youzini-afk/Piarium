import os from 'node:os';
import path from 'node:path';

export const resolveVarinDataDir = (
  processLike: Pick<NodeJS.Process, 'env' | 'platform'> = process,
): string => {
  const configured = processLike.env?.VARIN_DATA_DIR;
  if (typeof configured === 'string' && configured.trim()) {
    return path.resolve(configured.trim());
  }
  if (processLike.platform === 'win32') {
    return path.join(
      processLike.env?.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Varin',
    );
  }
  if (processLike.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Varin');
  }
  return path.join(processLike.env?.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'varin');
};
