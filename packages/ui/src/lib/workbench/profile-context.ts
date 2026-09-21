import React from 'react';
import { VARIN_WORKBENCH_DEFAULT_PROFILE_ID } from '@varin/extension-contract';

export const WorkbenchProfileContext = React.createContext<string>(VARIN_WORKBENCH_DEFAULT_PROFILE_ID);

export const useWorkbenchProfileId = (): string => React.useContext(WorkbenchProfileContext);
