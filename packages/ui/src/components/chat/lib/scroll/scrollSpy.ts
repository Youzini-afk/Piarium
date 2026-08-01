export type OffsetTurn = {
    id: string;
    top: number;
};

export type VisibleTurn = {
    id: string;
    ratio: number;
    top: number;
};

export const computeIntersectionRatio = (
    elementRect: { top: number; bottom: number; height: number },
    containerRect: { top: number; bottom: number },
): number => {
    if (elementRect.height <= 0) return 0;
    const overlap = Math.min(elementRect.bottom, containerRect.bottom)
        - Math.max(elementRect.top, containerRect.top);
    if (overlap <= 0) return 0;
    return Math.min(1, overlap / elementRect.height);
};

export const measureVisibleTurnGeometry = (
    element: HTMLElement,
    container: HTMLElement,
): { ratio: number; top: number } => {
    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
        ratio: computeIntersectionRatio(elementRect, containerRect),
        top: elementRect.top,
    };
};

type ScrollSpyInput = {
    onActive: (id: string) => void;
    raf?: (cb: FrameRequestCallback) => number;
    caf?: (id: number) => void;
    // Kept in the injectable test surface for compatibility. The production
    // picker intentionally no longer depends on IntersectionObserver ratios.
    IntersectionObserver?: typeof globalThis.IntersectionObserver;
    ResizeObserver?: typeof globalThis.ResizeObserver;
    MutationObserver?: typeof globalThis.MutationObserver;
};

export const pickVisibleTurnId = (list: VisibleTurn[], line: number): string | undefined => {
    if (list.length === 0) return undefined;
    const sorted = [...list].sort((a, b) => {
        if (b.ratio !== a.ratio) return b.ratio - a.ratio;
        const distance = Math.abs(a.top - line) - Math.abs(b.top - line);
        return distance || a.top - b.top;
    });
    return sorted[0]?.id;
};

// Reading line offset below the container top. The active turn is the last
// one whose top edge sits at or above this line — a monotonic rule that stays
// stable while scrolling inside a long turn (no visibility-ratio flip-flop).
const READ_LINE_OFFSET_PX = 100;

// The chat treats its bottom spacer as part of the pinned zone. Match that
// boundary here so the rail reaches the final prompt even when its top never
// crosses the reading line before the viewport enters that spacer.
const BOTTOM_ANCHOR_MIN_PX = 48;
const BOTTOM_ANCHOR_VIEWPORT_FACTOR = 0.1;

const isInBottomAnchorZone = (container: HTMLDivElement): boolean => {
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom <= Math.max(BOTTOM_ANCHOR_MIN_PX, container.clientHeight * BOTTOM_ANCHOR_VIEWPORT_FACTOR);
};

export const pickOffsetTurnId = (list: OffsetTurn[], cutoff: number): string | undefined => {
    if (list.length === 0) {
        return undefined;
    }

    let lo = 0;
    let hi = list.length - 1;
    let out = 0;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const top = list[mid]?.top;
        if (top === undefined) {
            break;
        }

        if (top <= cutoff) {
            out = mid;
            lo = mid + 1;
            continue;
        }

        hi = mid - 1;
    }

    return list[out]?.id;
};

export const createScrollSpy = (input: ScrollSpyInput) => {
    const raf = input.raf ?? requestAnimationFrame;
    const caf = input.caf ?? cancelAnimationFrame;
    const CtorRO = input.ResizeObserver ?? globalThis.ResizeObserver;
    const CtorMO = input.MutationObserver ?? globalThis.MutationObserver;

    let root: HTMLDivElement | undefined;
    let ro: ResizeObserver | undefined;
    let mo: MutationObserver | undefined;
    let frame: number | undefined;
    let roDebounce: ReturnType<typeof setTimeout> | undefined;
    let active: string | undefined;
    let dirty = true;

    const nodes = new Map<string, HTMLElement>();
    let offsets: OffsetTurn[] = [];

    const schedule = () => {
        if (frame !== undefined) {
            return;
        }
        frame = raf(() => {
            frame = undefined;
            update();
        });
    };

    const refreshOffsets = () => {
        const container = root;
        if (!container) {
            offsets = [];
            dirty = false;
            return;
        }

        const baseTop = container.getBoundingClientRect().top;
        offsets = [...nodes].map(([key, element]) => ({
            id: key,
            top: element.getBoundingClientRect().top - baseTop + container.scrollTop,
        }));
        offsets.sort((a, b) => a.top - b.top);
        dirty = false;
    };

    const update = () => {
        const container = root;
        if (!container) {
            return;
        }

        if (dirty) {
            refreshOffsets();
        }

        const next = isInBottomAnchorZone(container)
            ? offsets[offsets.length - 1]?.id
            : pickOffsetTurnId(offsets, container.scrollTop + READ_LINE_OFFSET_PX);
        if (!next || next === active) {
            return;
        }

        active = next;
        input.onActive(next);
    };

    const observe = () => {
        const container = root;
        if (!container) {
            return;
        }

        clearTimeout(roDebounce);
        roDebounce = undefined;
        ro?.disconnect();
        ro = undefined;
        if (CtorRO) {
            ro = new CtorRO(() => {
                clearTimeout(roDebounce);
                roDebounce = setTimeout(() => {
                    dirty = true;
                    schedule();
                }, 100);
            });
            ro.observe(container);
            for (const element of nodes.values()) {
                ro.observe(element);
            }
        }

        mo?.disconnect();
        mo = undefined;
        if (CtorMO) {
            mo = new CtorMO((records) => {
                // Without subtree:true, MO only fires for direct children of
                // the scroll container. The turn nodes are direct children of
                // the inner content wrapper, but turn-internal mutations
                // (streaming text growth, tool reveal) should not invalidate
                // the spy. Filter to only count records whose target is a
                // turn node container — everything else is interior churn.
                let changed = false;
                for (const record of records) {
                    const target = record.target;
                    if (!(target instanceof HTMLElement)) continue;
                    if (!target.dataset.turnId && !target.hasAttribute('data-turn-entry')) {
                        continue;
                    }
                    if (record.addedNodes.length > 0 || record.removedNodes.length > 0) {
                        changed = true;
                        break;
                    }
                }
                if (changed) {
                    dirty = true;
                    schedule();
                }
            });
            // childList only — no subtree. We only care about turn nodes being
            // added/removed at the container level, not interior churn.
            const moConfig: MutationObserverInit = {
                childList: true,
            };
            if (!CtorRO) {
                moConfig.characterData = true;
                moConfig.characterDataOldValue = false;
            }
            mo.observe(container, moConfig);
        }

        dirty = true;
        schedule();
    };

    const setContainer = (element?: HTMLDivElement) => {
        if (root === element) {
            return;
        }

        root = element;
        active = undefined;
        observe();
    };

    const register = (element: HTMLElement, key: string) => {
        const previous = nodes.get(key);
        if (previous && previous !== element) {
            ro?.unobserve(previous);
        }

        nodes.set(key, element);
        if (ro) {
            ro.observe(element);
        }
        dirty = true;
        schedule();
    };

    const unregister = (key: string) => {
        const element = nodes.get(key);
        if (!element) {
            return;
        }

        ro?.unobserve(element);
        nodes.delete(key);
        dirty = true;
        schedule();
    };

    const markDirty = () => {
        dirty = true;
        schedule();
    };

    const clear = () => {
        for (const element of nodes.values()) {
            ro?.unobserve(element);
        }

        nodes.clear();
        offsets = [];
        active = undefined;
        dirty = true;
    };

    const destroy = () => {
        if (frame !== undefined) {
            caf(frame);
        }
        frame = undefined;
        clearTimeout(roDebounce);
        roDebounce = undefined;
        clear();
        ro?.disconnect();
        mo?.disconnect();
        ro = undefined;
        mo = undefined;
        root = undefined;
    };

    return {
        setContainer,
        register,
        unregister,
        onScroll: schedule,
        markDirty,
        clear,
        destroy,
        getActiveId: () => active,
    };
};
