/* eslint-disable react-refresh/only-export-components */
import React from 'react';

type MobileWorkspaceShellProps = {
  onActiveConnectionDeleted: () => void;
};

type MobileWorkspaceShellRenderer = (props: MobileWorkspaceShellProps) => React.ReactNode;

let renderer: MobileWorkspaceShellRenderer | null = null;

export const bindMobileWorkspaceShell = (next: MobileWorkspaceShellRenderer | null): void => {
  renderer = next;
};

export const MobileWorkspaceShell: React.FC<MobileWorkspaceShellProps> = (props) => (
  renderer ? <>{renderer(props)}</> : null
);
