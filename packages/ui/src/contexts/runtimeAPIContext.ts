import React from 'react';
import type { RuntimeAPIs } from '@piarium/application-client';

export const RuntimeAPIContext = React.createContext<RuntimeAPIs | null>(null);
