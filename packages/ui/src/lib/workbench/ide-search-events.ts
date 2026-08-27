export type IdeSearchMode = 'files' | 'content';

export interface IdeSearchRequest {
  mode: IdeSearchMode;
}

export const IDE_SEARCH_REQUEST_EVENT = 'piarium:ide-search-request';

/**
 * Ask the active workbench shell to reveal IDE Search. The cancelable event is
 * also an ownership handshake: a shell calls preventDefault() when it handled
 * the request, allowing Agent/mobile profiles to keep their existing fallback.
 */
export const requestIdeSearch = (request: IdeSearchRequest): boolean => {
  if (typeof window === 'undefined') return false;
  const event = new CustomEvent<IdeSearchRequest>(IDE_SEARCH_REQUEST_EVENT, {
    cancelable: true,
    detail: request,
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

export const subscribeIdeSearchRequests = (
  listener: (request: IdeSearchRequest) => boolean | void,
): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const handle = (raw: Event): void => {
    const event = raw as CustomEvent<IdeSearchRequest>;
    if (event.detail?.mode !== 'files' && event.detail?.mode !== 'content') return;
    if (listener(event.detail) !== false) event.preventDefault();
  };
  window.addEventListener(IDE_SEARCH_REQUEST_EVENT, handle);
  return () => window.removeEventListener(IDE_SEARCH_REQUEST_EVENT, handle);
};
