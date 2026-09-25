import { describe, expect, it } from 'vitest';
import { calculateOverlayThumbMetrics } from './overlayScrollbarMetrics';

describe('calculateOverlayThumbMetrics', () => {
  it('uses an external full-height track and reaches its bottom at max scroll', () => {
    const metrics = calculateOverlayThumbMetrics({
      viewportLength: 500,
      contentLength: 2000,
      scrollOffset: 1500,
      trackLength: 900,
      minThumbSize: 32,
      trackInset: 8,
    });

    expect(metrics.length).toBeCloseTo(221);
    expect(metrics.offset).toBeCloseTo(663);
    expect(8 + metrics.offset + metrics.length).toBeCloseTo(892);
  });

  it('hides the thumb when content does not overflow', () => {
    expect(calculateOverlayThumbMetrics({
      viewportLength: 500,
      contentLength: 500,
      scrollOffset: 0,
      trackLength: 900,
      minThumbSize: 32,
    })).toEqual({ length: 0, offset: 0 });
  });
});
