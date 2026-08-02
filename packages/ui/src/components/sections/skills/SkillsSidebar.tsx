import React from 'react';
import { PiResourceSidebar } from '@/components/sections/resources/PiResourceSidebar';

export const SkillsSidebar: React.FC<{ onItemSelect?: () => void }> = ({ onItemSelect }) => (
  <PiResourceSidebar kind="skill" onItemSelect={onItemSelect} />
);
