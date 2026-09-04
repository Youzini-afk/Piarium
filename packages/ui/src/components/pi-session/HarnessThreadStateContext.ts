import React from 'react';
import type { ThreadParent } from '@piarium/protocol';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';

export interface HarnessThreadStateValue {
  merge(snapshot: HarnessThreadSnapshot): void;
  parent: ThreadParent;
  threads: HarnessThreadSnapshot[];
  workspaceId: string;
}

const EMPTY_STATE: HarnessThreadStateValue = {
  merge: () => {},
  parent: { kind: 'session', id: '' },
  threads: [],
  workspaceId: '',
};

export const HarnessThreadStateContext = React.createContext<HarnessThreadStateValue>(EMPTY_STATE);

export const useHarnessThreadState = (): HarnessThreadStateValue => React.useContext(HarnessThreadStateContext);
