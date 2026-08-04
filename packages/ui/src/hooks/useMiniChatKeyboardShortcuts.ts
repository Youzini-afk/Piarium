import React from 'react';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { startPiSessionDraftFromNavigation } from '@/lib/pi-runtime/sessionNavigation';

export const useMiniChatKeyboardShortcuts = () => {
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  React.useEffect(() => {
    const combo = (actionId: string) => getEffectiveShortcutCombo(actionId, shortcutOverrides);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (eventMatchesShortcut(event, combo('focus_input'))) {
        event.preventDefault();
        focusChatInput();
        return;
      }

      if (canUseElectronDesktopIPC() && eventMatchesShortcut(event, combo('new_mini_chat'))) {
        event.preventDefault();
        void invokeDesktop('desktop_open_draft_mini_chat_window', {
          directory: currentDirectory || activeProject?.path || '',
          projectId: activeProject?.id ?? null,
        })?.catch((error) => {
          console.warn('[mini-chat-shortcuts] failed to open draft mini chat window', error);
        });
        return;
      }

      if (eventMatchesShortcut(event, combo('new_chat'))) {
        const cwd = currentDirectory || activeProject?.path || '';
        if (!cwd) return;
        event.preventDefault();
        void startPiSessionDraftFromNavigation({
          directory: cwd,
          projectId: activeProject?.id ?? null,
        })
          .then(() => focusChatInput())
          .catch((error) => console.warn('[mini-chat-shortcuts] failed to start Pi session draft', error));
        return;
      }

      if (eventMatchesShortcut(event, combo('open_model_selector'))) {
        event.preventDefault();
        const { isModelSelectorOpen, setModelSelectorOpen } = useUIStore.getState();
        setModelSelectorOpen(!isModelSelectorOpen);
        return;
      }

      if (eventMatchesShortcut(event, combo('cycle_thinking_variant'))) {
        const sessions = usePiSessionStore.getState();
        const sessionId = sessions.currentSessionId;
        const snapshot = sessionId ? sessions.records[sessionId]?.snapshot : undefined;
        const levels = snapshot?.model?.supportedThinkingLevels ?? [];
        if (!sessionId || levels.length === 0) return;
        event.preventDefault();
        const currentIndex = levels.indexOf(snapshot?.thinkingLevel ?? 'off');
        const next = levels[(currentIndex + 1 + levels.length) % levels.length];
        void sessions.selectThinking(sessionId, next).catch((error) => {
          console.warn('[mini-chat-shortcuts] failed to cycle Pi thinking level', error);
        });
        return;
      }

      const cyclesForward = eventMatchesShortcut(event, combo('cycle_favorite_model_forward'));
      const cyclesBackward = eventMatchesShortcut(event, combo('cycle_favorite_model_backward'));
      if (!cyclesForward && !cyclesBackward) return;

      const ui = useUIStore.getState();
      const sessions = usePiSessionStore.getState();
      const sessionId = sessions.currentSessionId;
      const snapshot = sessionId ? sessions.records[sessionId]?.snapshot : undefined;
      if (!sessionId || ui.favoriteModels.length === 0) return;
      const providers = usePiProviderStore.getState().providers;
      const availableFavorites = ui.favoriteModels.filter((favorite) => (
        providers
          .find((provider) => provider.id === favorite.providerID)
          ?.models.some((model) => model.id === favorite.modelID && model.available) === true
      ));
      if (availableFavorites.length === 0) return;

      event.preventDefault();
      const currentIndex = availableFavorites.findIndex((favorite) => (
        favorite.providerID === snapshot?.model?.provider && favorite.modelID === snapshot?.model?.id
      ));
      const delta = cyclesForward ? 1 : -1;
      const next = availableFavorites[
        (currentIndex + delta + availableFavorites.length) % availableFavorites.length
      ];
      void sessions.selectModel(sessionId, { id: next.modelID, provider: next.providerID })
        .then(() => ui.addRecentModel(next.providerID, next.modelID))
        .catch((error) => console.warn('[mini-chat-shortcuts] failed to cycle Pi model', error));
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeProject?.id, activeProject?.path, currentDirectory, shortcutOverrides]);
};
