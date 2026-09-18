import { createContext, useContext } from 'react';

export const SettingsSearchTargetContext = createContext<string | null>(null);
export const useSettingsSearchTarget = () => useContext(SettingsSearchTargetContext);
