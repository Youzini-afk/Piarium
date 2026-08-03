import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const read = (relativePath: string): string => (
  readFileSync(new URL(relativePath, import.meta.url), 'utf8')
);

describe('Pi workspace surfaces', () => {
  test('keep terminal, Git, pull requests, and embedded chat off the legacy session graph', () => {
    const sources = [
      './TerminalView.tsx',
      './GitView.tsx',
      './PullRequestView.tsx',
      './git/ConflictDialog.tsx',
      './git/IntegrateCommitsSection.tsx',
      './git/PullRequestSection.tsx',
      '../layout/ContextPanel.tsx',
      '../../lib/worktrees/worktreeManager.ts',
    ].map(read).join('\n');

    expect(sources).not.toContain('useSessionUIStore');
    expect(sources).not.toContain('session-ui-store');
    expect(sources).not.toContain('sync-context');
    expect(sources).not.toContain('useConfigStore');
    expect(sources).not.toContain('opencodeClient');
  });

  test('routes workspace context through Pi session drafts', () => {
    const terminal = read('./TerminalView.tsx');
    const pullRequests = read('./git/PullRequestSection.tsx');
    const conflictFlows = [
      read('./git/ConflictDialog.tsx'),
      read('./git/IntegrateCommitsSection.tsx'),
    ].join('\n');

    expect(terminal).toContain('ensurePiSessionDraftTarget');
    expect(pullRequests).toContain('ensurePiSessionDraftTarget');
    expect(conflictFlows).toContain('stagePiSessionDraft');
    expect(conflictFlows).toContain('createPiSessionWithDraft');
  });
});
