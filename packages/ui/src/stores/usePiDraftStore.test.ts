import { beforeEach, describe, expect, test } from 'bun:test';
import { piDraftKey, readPiDraft, usePiDraftStore } from './usePiDraftStore';

describe('Pi draft store', () => {
  beforeEach(() => usePiDraftStore.setState({ drafts: {} }));

  test('keeps session drafts isolated by runtime and session', () => {
    usePiDraftStore.setState({
      drafts: {
        [piDraftKey('same', 'runtime-a')]: { images: [], text: 'A' },
        [piDraftKey('same', 'runtime-b')]: { images: [], text: 'B' },
      },
    });
    expect(usePiDraftStore.getState().drafts[piDraftKey('same', 'runtime-a')]?.text).toBe('A');
    expect(usePiDraftStore.getState().drafts[piDraftKey('same', 'runtime-b')]?.text).toBe('B');
  });

  test('appends panel context without overwriting existing user text', () => {
    usePiDraftStore.getState().setDraft('session-1', { text: 'User prompt' });
    usePiDraftStore.getState().appendText('session-1', 'Preview annotation');
    expect(readPiDraft('session-1').text).toBe('User prompt\n\nPreview annotation');
  });

  test('clears the complete draft after a successful send', () => {
    usePiDraftStore.getState().setDraft('session-1', {
      images: [{ data: 'image', mimeType: 'image/png' }],
      text: 'Prompt',
    });
    usePiDraftStore.getState().clear('session-1');
    expect(readPiDraft('session-1')).toEqual({ images: [], text: '' });
  });
});
