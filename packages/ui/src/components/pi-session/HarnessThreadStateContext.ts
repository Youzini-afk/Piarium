import React from 'react';
import type { ThreadParent } from '@piarium/protocol';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';

export interface HarnessThreadStateValue {
  includeArchived: boolean;
  merge(snapshot: HarnessThreadSnapshot): void;
  parent: ThreadParent;
  reload(): Promise<void>;
  setIncludeArchived(value: boolean): void;
  threads: HarnessThreadSnapshot[];
  workspaceId: string;
}

const EMPTY_STATE: HarnessThreadStateValue = {
  includeArchived: false,
  merge: () => {},
  parent: { kind: 'session', id: '' },
  reload: async () => {},
  setIncludeArchived: () => {},
  threads: [],
  workspaceId: '',
};

export const HarnessThreadStateContext = React.createContext<HarnessThreadStateValue>(EMPTY_STATE);

export const useHarnessThreadState = (): HarnessThreadStateValue => React.useContext(HarnessThreadStateContext);
