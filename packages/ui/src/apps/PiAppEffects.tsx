import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { usePiSessionAutoCleanup } from '@/hooks/usePiSessionAutoCleanup';
import { useWindowControlsOverlayLayout } from '@/hooks/useWindowControlsOverlayLayout';

export function PiAppEffects({ backgroundWorkEnabled }: {
  backgroundWorkEnabled: boolean;
}) {
  usePiSessionAutoCleanup(backgroundWorkEnabled);
  usePwaManifestSync();
  useWindowControlsOverlayLayout();
  useKeyboardShortcuts();
  return null;
}
