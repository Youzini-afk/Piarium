import type * as fs from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import type * as path from 'node:path';

export type PiariumSettingsDocument = Record<string, unknown>;

export interface SettingsFileStore {
  readonly filePath: string;
  read(): Promise<PiariumSettingsDocument>;
  readSync(): PiariumSettingsDocument;
  replace(settings: PiariumSettingsDocument): Promise<PiariumSettingsDocument>;
  update(
    mutator: (
      current: PiariumSettingsDocument,
    ) => PiariumSettingsDocument | void | Promise<PiariumSettingsDocument | void>,
  ): Promise<PiariumSettingsDocument>;
}

export interface SettingsFileStoreOptions {
  filePath: string;
  fsModule?: Pick<typeof fs, 'readFileSync'>;
  fsPromises?: Pick<
    typeof fsPromises,
    'chmod' | 'mkdir' | 'open' | 'readFile' | 'rename' | 'rm' | 'stat' | 'writeFile'
  >;
  pathModule?: Pick<typeof path, 'dirname' | 'resolve'>;
  processLike?: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>;
}

export function createSettingsFileStore(options: SettingsFileStoreOptions): SettingsFileStore;
