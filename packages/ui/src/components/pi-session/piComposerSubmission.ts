// Re-export from lib/ for backward compatibility.
// The canonical location is lib/pi-session/piComposerSubmission.ts.
// This file exists because some component imports still reference it.
export {
  renderPiComposerSubmission,
  type PiComposerSubmission,
  type MagicPromptRenderer,
} from '@/lib/pi-session/piComposerSubmission';
