import fs from 'fs';
import os from 'os';
import path from 'path';

// The walkthrough may run on a different model than the rest of the small-model
// callers. Those callers want cheap and fast; this one needs structured output
// and enough context for a whole diff, and forcing one setting to serve both
// means the user has to degrade one feature to fix the other.

const SETTINGS_FILE = path.join(
  process.env.PIARIUM_DATA_DIR
    ? path.resolve(process.env.PIARIUM_DATA_DIR)
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Piarium')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Piarium')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'piarium'),
  'settings.json',
);

/**
 * The explicit walkthrough model, or `null` to fall back to normal small-model
 * resolution.
 *
 * Having chosen a model *is* the opt-out; a separate toggle would let the two
 * disagree, and then clearing the picker would leave a setting that says "do
 * not use the small model" with nothing to use instead.
 */
export function readWalkthroughModelOverride(): string | null {
  try {
    const settings: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
    const record = settings as Record<string, unknown>;
    const override = typeof record.walkthroughModelOverride === 'string'
      ? record.walkthroughModelOverride.trim()
      : '';
    return override || null;
  } catch {
    // No settings file, unreadable, or malformed all mean the same thing: no
    // override, use the small model.
    return null;
  }
}
