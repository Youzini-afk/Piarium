import React from 'react';
import {
  getWorkbenchShellStagingRequest,
  mountWorkbenchShellStagingHost,
  settleWorkbenchShellStagingFailure,
  settleWorkbenchShellStagingReady,
  subscribeWorkbenchShellStaging,
  type WorkbenchShellStagingRequest,
} from './workbench-shell-staging-store';

interface StagingBoundaryProps {
  request: WorkbenchShellStagingRequest;
}

interface StagingBoundaryState {
  failed: boolean;
}

class StagingBoundary extends React.Component<StagingBoundaryProps, StagingBoundaryState> {
  state: StagingBoundaryState = { failed: false };

  static getDerivedStateFromError(): StagingBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    settleWorkbenchShellStagingFailure(this.props.request, error);
  }

  render(): React.ReactNode {
    if (this.state.failed) return null;
    return <StagedContribution request={this.props.request} />;
  }
}

const ReadySignal: React.FC<{ request: WorkbenchShellStagingRequest }> = ({ request }) => {
  React.useLayoutEffect(() => {
    settleWorkbenchShellStagingReady(request);
  }, [request]);
  return null;
};

const StagedContribution: React.FC<{ request: WorkbenchShellStagingRequest }> = ({ request }) => {
  const implementation = request.contribution.implementation as {
    Component?: React.ComponentType<Record<string, unknown>>;
    framework?: unknown;
    props?: Record<string, unknown>;
    render?(props: Readonly<Record<string, unknown>>): React.ReactNode;
  };
  let rendered: React.ReactNode;
  if (implementation.framework === 'react-19' && typeof implementation.Component === 'function') {
    const Component = implementation.Component;
    rendered = <Component {...implementation.props} {...request.props} />;
  } else if (typeof implementation.render === 'function') {
    rendered = implementation.render(request.props);
  } else {
    throw new TypeError(`Workbench shell ${request.contribution.descriptor.id} has no render implementation`);
  }
  if (rendered === null || rendered === undefined) {
    throw new TypeError(`Workbench shell ${request.contribution.descriptor.id} rendered no content`);
  }
  return <>{rendered}<ReadySignal request={request} /></>;
};

export const WorkbenchShellStagingHost: React.FC = () => {
  const request = React.useSyncExternalStore(
    subscribeWorkbenchShellStaging,
    getWorkbenchShellStagingRequest,
    getWorkbenchShellStagingRequest,
  );
  React.useLayoutEffect(mountWorkbenchShellStagingHost, []);
  if (!request) return null;
  return (
    <div
      aria-hidden="true"
      data-piarium-workbench-shell-staging=""
      style={{
        inset: 0,
        pointerEvents: 'none',
        position: 'fixed',
        visibility: 'hidden',
        zIndex: -1,
      }}
    >
      <StagingBoundary key={request.id} request={request} />
    </div>
  );
};
