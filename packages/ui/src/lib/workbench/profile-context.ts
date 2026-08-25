import React from 'react';
import { PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID } from '@piarium/extension-contract';

export const WorkbenchProfileContext = React.createContext<string>(PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID);

export const useWorkbenchProfileId = (): string => React.useContext(WorkbenchProfileContext);
