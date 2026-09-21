import React from 'react';
import type { RuntimeAPIs } from '@varin/application-client';

export const RuntimeAPIContext = React.createContext<RuntimeAPIs | null>(null);
