# Composer

The shared Pi prompt composer is orchestrated by
`components/pi-session/PiComposer.tsx`. Agent Profile, IDE Profile, desktop,
Web, mobile, mini chat, and the VS Code companion all reach the same component
through `PiChatView`; they do not own separate send semantics.

## Ownership

| Area | Owner |
|---|---|
| Prompt text, images, and pending first-turn configuration | `usePiDraftStore` |
| Existing session model and thinking level | Pi runtime `SessionSnapshot` |
| Provider/model catalog | `usePiProviderStore` and `ModelPickerList` |
| New-session defaults | Pi settings, with Piarium project metadata allowed to override the model |
| Prompt parsing and rendering | `language/`, `editor/`, and `piComposerSubmission.ts` |
| Process execution and model mutation | Pi Host through `usePiSessionStore` |

The UI may stage a model or thinking choice for a session that does not exist
yet. It must not pretend that choice is live: `PiChatView` creates the session,
applies the staged model, applies a compatible explicit thinking level, and
only then sends the first prompt. Once the session exists, the returned
`SessionSnapshot` is authoritative.

`undefined` in a pending draft means “inherit”. It is not copied into a second
global settings system. The composer displays the effective Pi/project default
while retaining that distinction, so selecting “Default” remains meaningful.

## Prompt language and editor

`language/` is the single source of truth for composer syntax. It recognizes
known `/command`, `/skill`, and `#snippet` tokens plus prompt markdown and path
references. Unknown tokens remain ordinary prose.

`editor/ComposerEditor.tsx` wraps CodeMirror, but its document is still a plain
string. The imperative surface is intentionally limited to caret operations
needed by autocomplete, dictation, and restored drafts; model selection and
send policy stay outside the editor.

CodeMirror owns text, selection, wrapping, undo history, and prompt
decorations. The native-selection overlay in `editor/theme.ts` is retained for
iOS handles and for selections over decorated tokens. Do not replace it with a
textarea/mirror pair: those two layers drift when typography changes and on
mobile wrapping.

## Model and thinking controls

`PiComposerModelControls` is part of the composer rather than the chat header.
The model trigger reuses the shared searchable model catalog, favorites,
recents, provider ordering, availability filtering, and mobile overlay. The
thinking menu is derived from the effective model's
`supportedThinkingLevels`; a stale explicit level is cleared when the user
chooses a model that cannot run it.

The global `open_model_selector` shortcut controls the picker anchored to the
active composer. Inactive profile surfaces must not mount a competing modal.

## Submission order

For a first prompt:

1. Create the Pi session in the chosen workspace.
2. Transfer the pending draft to the new session so a later configuration
   failure cannot orphan the user's text.
3. Apply the explicit draft model, or the Piarium project model when present.
4. Apply an explicit thinking level after checking the selected model.
5. Render Piarium magic prompts, snippets, inline comments, editor context, and
   goal state.
6. Send through Pi `prompt`.

For an existing busy session, the configured follow-up behavior decides between
Pi `steer` and `followUp`. The composer never emulates those queues locally.

## Verification

Pure configuration/default resolution and submission assembly are unit tested.
Rendering, focus, IME, mobile keyboards, clipboard images, and overlay handoff
still require a real browser or shell check; type-checking alone does not prove
those behaviors.
