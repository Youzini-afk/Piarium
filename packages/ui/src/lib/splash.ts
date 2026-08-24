import {
  SPLASH_EXIT_DURATION_MS,
  SPLASH_HANDOFF_ATTRIBUTE,
} from '@/components/ui/piarium-splash-lattice';

/**
 * Talks to the pre-paint splash in `packages/web/index.html`.
 *
 * That splash has to exist before the bundle does, so it is plain markup the app can only reach
 * through the DOM. Keeping every one of those reaches here means the element's contract — its id, its
 * status line, how it is told to leave — is stated once instead of being re-derived at each call site.
 * Two earlier call sites assigned `textContent` on the container, which deleted the mark's SVG and
 * left a bare sentence on a coloured field; writing to a dedicated status element keeps the mark.
 */

const SPLASH_ID = 'initial-loading';
const STATUS_ID = 'initial-loading-status';
/** The floor container the generated pre-paint script fills. Nothing in the app reads it after that. */
const GROUND_ID = 'initial-loading-ground';

/**
 * The splash is told to leave through the same attribute the React splash uses, so one stylesheet
 * drives both. Its exit duration comes from the module that declares the animation rather than being
 * restated here, because a copy would drift and the element would be removed mid-animation.
 */
const LEAVING_ATTRIBUTE = 'data-leaving';

let removalTimer: ReturnType<typeof setTimeout> | null = null;

const splashElement = (): HTMLElement | null => {
  if (typeof document === 'undefined') return null;
  return document.getElementById(SPLASH_ID);
};

/**
 * Whether the pre-paint splash still owns the screen.
 *
 * React's own loading screens check this so they do not stack a second cover, with a second fade, on
 * top of the one already painted.
 */
export const isInitialSplashPresent = (): boolean => splashElement() !== null;

/**
 * Replace the splash's status line.
 *
 * Callers pass translated text. The line is a separate element, so the mark survives and a later
 * message can replace an earlier one.
 */
export const setInitialSplashStatus = (message: string): void => {
  const status = typeof document === 'undefined' ? null : document.getElementById(STATUS_ID);
  if (!status) return;
  status.textContent = message;
};

/**
 * Run the splash's exit and remove it.
 *
 * Idempotent: startup has several paths that can each decide the app is ready, and the first one to
 * arrive should win without the others restarting the animation.
 */
export const dismissInitialSplash = (): void => {
  const element = splashElement();
  if (!element || removalTimer !== null) return;

  const ownerDocument = element.ownerDocument;
  const documentElement = ownerDocument.documentElement;
  documentElement.setAttribute(SPLASH_HANDOFF_ATTRIBUTE, 'true');
  element.setAttribute(LEAVING_ATTRIBUTE, 'true');
  removalTimer = setTimeout(() => {
    removalTimer = null;
    element.remove();

    // `requestAnimationFrame` runs before paint. Waiting for the following frame keeps the semantic splash
    // background underneath the first fully committed application frame, then releases it without extending
    // the visible transition. The timeout fallback is only for DOM hosts without a visual frame scheduler.
    const requestFrame = ownerDocument.defaultView?.requestAnimationFrame?.bind(ownerDocument.defaultView);
    if (!requestFrame) {
      setTimeout(() => documentElement.removeAttribute(SPLASH_HANDOFF_ATTRIBUTE), 0);
      return;
    }
    requestFrame(() => {
      requestFrame(() => documentElement.removeAttribute(SPLASH_HANDOFF_ATTRIBUTE));
    });
  }, SPLASH_EXIT_DURATION_MS);
};

/**
 * The hooks this module depends on. `piarium-logo-geometry.test.ts` asserts that every host still
 * provides them, because a rename there would silently stop status messages appearing or leave the
 * cover on screen rather than failing anywhere a reader would notice.
 */
export const INITIAL_SPLASH_IDS = {
  root: SPLASH_ID,
  status: STATUS_ID,
  ground: GROUND_ID,
  handoffAttribute: SPLASH_HANDOFF_ATTRIBUTE,
  leavingAttribute: LEAVING_ATTRIBUTE,
} as const;
