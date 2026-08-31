import React from 'react';

import { cn } from '@/lib/utils';
import type { EditorGroupLeaf, EditorGroupNode, EditorTab } from '@/lib/workbench/editors/types';
import { listEditorGroups } from '@/lib/workbench/editors/groups';
import { EditorGroupTabs } from '@/components/workbench/EditorGroupTabs';

type EditorGroupsLayoutProps = {
  tree: EditorGroupNode;
  activeGroupId: string;
  workspaceRoot: string;
  workspaceId?: string;
  dirtyResourceIds: ReadonlySet<string>;
  alwaysShowActions: boolean;
  isMobile: boolean;
  onActivate: (groupId: string, tabId: string) => void;
  onClose: (tabId: string) => void;
  onPin: (tabId: string, pinned: boolean) => void;
  onMove: (tabId: string, targetGroupId: string) => void;
  onSplitRatio: (splitId: string, ratio: number) => void;
  renderEditor: (group: EditorGroupLeaf, tab: EditorTab | undefined) => React.ReactNode;
};

const SplitHandle: React.FC<{
  direction: 'horizontal' | 'vertical';
  ratio: number;
  onRatio: (ratio: number) => void;
}> = ({ direction, ratio, onRatio }) => {
  const start = React.useRef<{ pos: number; size: number; ratio: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation={direction === 'vertical' ? 'vertical' : 'horizontal'}
      className={cn(
        'shrink-0 bg-border/60 hover:bg-primary/40',
        direction === 'vertical' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
      )}
      onPointerDown={(event) => {
        const target = event.currentTarget.parentElement;
        if (!target) return;
        const size = direction === 'vertical' ? target.clientWidth : target.clientHeight;
        start.current = {
          pos: direction === 'vertical' ? event.clientX : event.clientY,
          size,
          ratio,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!start.current || start.current.size <= 0) return;
        const pos = direction === 'vertical' ? event.clientX : event.clientY;
        onRatio(start.current.ratio + (pos - start.current.pos) / start.current.size);
      }}
      onPointerUp={() => {
        start.current = null;
      }}
    />
  );
};

const EditorGroupPane: React.FC<{
  group: EditorGroupLeaf;
  activeGroupId: string;
  workspaceRoot: string;
  workspaceId?: string;
  dirtyResourceIds: ReadonlySet<string>;
  alwaysShowActions: boolean;
  isMobile: boolean;
  otherGroups: EditorGroupLeaf[];
  onActivate: (groupId: string, tabId: string) => void;
  onClose: (tabId: string) => void;
  onPin: (tabId: string, pinned: boolean) => void;
  onMove: (tabId: string, targetGroupId: string) => void;
  renderEditor: (group: EditorGroupLeaf, tab: EditorTab | undefined) => React.ReactNode;
}> = ({
  group,
  activeGroupId,
  workspaceRoot,
  workspaceId,
  dirtyResourceIds,
  alwaysShowActions,
  isMobile,
  otherGroups,
  onActivate,
  onClose,
  onPin,
  onMove,
  renderEditor,
}) => {
  const activeTab = group.tabs.find((tab) => tab.tabId === group.activeTabId) ?? group.tabs[0];
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      onMouseDown={() => {
        if (activeTab) onActivate(group.groupId, activeTab.tabId);
      }}
    >
      <div className="flex-shrink-0 border-b border-border/40">
        <EditorGroupTabs
          group={group}
          workspaceRoot={workspaceRoot}
          workspaceId={workspaceId}
          dirtyResourceIds={dirtyResourceIds}
          isActiveGroup={group.groupId === activeGroupId}
          alwaysShowActions={alwaysShowActions}
          isMobile={isMobile}
          onActivate={(tabId) => onActivate(group.groupId, tabId)}
          onClose={onClose}
          onPin={onPin}
          onMoveToGroup={onMove}
          otherGroupIds={otherGroups.map((candidate, index) => ({
            groupId: candidate.groupId,
            label: String(index + 1),
          }))}
        />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {renderEditor(group, activeTab)}
      </div>
    </div>
  );
};

const EditorNode: React.FC<EditorGroupsLayoutProps & { node: EditorGroupNode }> = ({
  node,
  ...rest
}) => {
  if (node.type === 'group') {
    return (
      <EditorGroupPane
        group={node}
        activeGroupId={rest.activeGroupId}
        workspaceRoot={rest.workspaceRoot}
        workspaceId={rest.workspaceId}
        dirtyResourceIds={rest.dirtyResourceIds}
        alwaysShowActions={rest.alwaysShowActions}
        isMobile={rest.isMobile}
        otherGroups={listEditorGroups(rest.tree).filter((group) => group.groupId !== node.groupId)}
        onActivate={rest.onActivate}
        onClose={rest.onClose}
        onPin={rest.onPin}
        onMove={rest.onMove}
        renderEditor={rest.renderEditor}
      />
    );
  }

  const flexDirection = node.direction === 'vertical' ? 'flex-row' : 'flex-col';
  return (
    <div className={cn('flex h-full min-h-0 min-w-0', flexDirection)}>
      <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: `${node.ratio} 1 0%` }}>
        <EditorNode node={node.first} {...rest} />
      </div>
      <SplitHandle
        direction={node.direction}
        ratio={node.ratio}
        onRatio={(next) => rest.onSplitRatio(node.splitId, next)}
      />
      <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: `${1 - node.ratio} 1 0%` }}>
        <EditorNode node={node.second} {...rest} />
      </div>
    </div>
  );
};

export const EditorGroupsLayout: React.FC<EditorGroupsLayoutProps> = (props) => (
  <div className="h-full min-h-0 min-w-0 overflow-hidden">
    <EditorNode node={props.tree} {...props} />
  </div>
);
