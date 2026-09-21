/**
 * Approved Varin fold mark: extended horizontal tips and a small diagonal separation.
 * Coordinates are centered; these exact two polygons serve flat assets and the cube's top face.
 */
export const VARIN_MARK_VIEWBOX_SIZE = 128;
export const VARIN_MARK_VIEWBOX = '-64 -64 128 128';
export const VARIN_MARK_SECONDARY_OPACITY = 0.6;

export const VARIN_MARK_POLYGONS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[-35, -19], [-11, -43], [44, -43], [57, -30], [2, -30], [-21, -7], [-21, 26], [-35, 12]],
  [[35, 19], [11, 43], [-44, 43], [-57, 30], [-2, 30], [21, 7], [21, -26], [35, -12]],
];

export const VARIN_MARK_PATHS = VARIN_MARK_POLYGONS.map((points) =>
  `M${points.map(([x, y]) => `${x} ${y}`).join(' L')} Z`,
);
