import React from 'react';
import { PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID } from '@piarium/extension-contract';

import { WorkbenchProfileContext } from './profile-context';

export const WorkbenchProfileProvider: React.FC<{
  children: React.ReactNode;
  profileId?: string | null;
}> = ({ children, profileId }) => (
  <WorkbenchProfileContext.Provider value={profileId?.trim() || PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID}>
    {children}
  </WorkbenchProfileContext.Provider>
);
