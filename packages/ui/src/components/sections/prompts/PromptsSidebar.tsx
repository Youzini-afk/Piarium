import React from 'react';
import { PiResourceSidebar } from '@/components/sections/resources/PiResourceSidebar';

export const PromptsSidebar: React.FC<{ onItemSelect?: () => void }> = ({ onItemSelect }) => (
  <PiResourceSidebar kind="prompt" onItemSelect={onItemSelect} />
);
