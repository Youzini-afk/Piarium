// @ts-nocheck
import os from 'node:os';
import path from 'node:path';

export const resolvePiariumDataDir = (processLike = process) => {
  const configured = processLike.env?.PIARIUM_DATA_DIR;
  if (typeof configured === 'string' && configured.trim()) {
    return path.resolve(configured.trim());
  }
  if (processLike.platform === 'win32') {
    return path.join(
      processLike.env?.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Piarium',
    );
  }
  if (processLike.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Piarium');
  }
  return path.join(processLike.env?.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'piarium');
};
