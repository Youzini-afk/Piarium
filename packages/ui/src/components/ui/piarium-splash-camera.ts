/**
 * One camera, shared by the splash floor and the splash mark.
 *
 * The floor and the mark have to agree exactly or the mark stops standing on it, and the previous
 * three attempts each failed at that seam. This module removes the seam: the camera is defined once,
 * the floor gets it as a CSS transform, and the mark gets it as projected SVG geometry. Neither can
 * drift because neither owns any of the numbers.
 *
 * Why perspective at all. Isometric is a parallel projection, so a ground plane drawn in it has no
 * vanishing point and no size gradient, which leaves the eye no cue to decide whether the plane
 * recedes below eye level or tilts up toward the viewer. That ambiguity is a property of the
 * projection, not of any parameter, and it is what made the isometric floor read as tilting upward.
 *
 * Why not CSS 3D. `transform-style: preserve-3d` stops a subtree being flattened, so every descendant
 * is composited in the parent's 3D space instead of the subtree being rasterised once. With a few
 * hundred floor cells that is a cost paid during startup, when the machine is already busiest. A single
 * `perspective() rotateX() rotateZ()` on the floor container keeps the default flat behaviour, so the
 * floor stays one transformed layer exactly as the isometric version did, and the mark is projected
 * here into ordinary SVG. Perspective without the bill.
 */

/**
 * Tilt about the horizontal axis. This is deliberately more top-down than the first perspective
 * version: at 64 degrees the near cells loomed while the horizon sat so high that the camera read as
 * looking up the floor. Fifty-eight keeps a real vanishing point while showing enough of the plane for
 * the cube's footprint and the outward tile motion to read as one surface.
 */
const CAMERA_TILT_DEG = 58;

/**
 * Rotation within the plane. 45 degrees puts a cube corner toward the viewer, which is the three
 * quarter view the mark is recognised by.
 */
const CAMERA_SPIN_DEG = 45;

/**
 * Distance from the eye to the projection plane, in pixels.
 *
 * Smaller converges harder. The original 1600px distance made the nearest rows more than five times the
 * height of the far reach; 1800px keeps the depth cue without letting the foreground dominate the mark.
 * It also bounds how far the floor may extend: a point whose depth approaches this distance projects to
 * infinity, and past it the image inverts.
 */
const CAMERA_DISTANCE_PX = 1800;

const RAD = Math.PI / 180;
const cosTilt = Math.cos(CAMERA_TILT_DEG * RAD);
const sinTilt = Math.sin(CAMERA_TILT_DEG * RAD);
const cosSpin = Math.cos(CAMERA_SPIN_DEG * RAD);
const sinSpin = Math.sin(CAMERA_SPIN_DEG * RAD);

export interface Point3 {
  readonly x: number;
  readonly y: number;
  /** Height above the floor. The floor is z = 0 and the mark stands in +z. */
  readonly z: number;
}

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/**
 * Depth toward the viewer, in CSS's convention where +z leaves the screen.
 *
 * Exposed because the mark's faces are painted back to front, and because the floor's extent has to be
 * checked against the camera distance.
 */
export const cameraDepth = (point: Point3): number => {
  // rotateZ first, then rotateX, matching the order the CSS transform list applies.
  const spunY = point.x * sinSpin + point.y * cosSpin;
  return spunY * sinTilt + point.z * cosTilt;
};

/**
 * Project a point in floor space onto the screen, relative to the transform origin.
 *
 * This is the same arithmetic CSS performs for `perspective(d) rotateX(a) rotateZ(b)`: the rotations
 * run right to left, then the projection divides by `1 - z / d`.
 */
export const projectPoint = (point: Point3): Point2 => {
  const spunX = point.x * cosSpin - point.y * sinSpin;
  const spunY = point.x * sinSpin + point.y * cosSpin;

  const tiltedY = spunY * cosTilt - point.z * sinTilt;
  const depth = spunY * sinTilt + point.z * cosTilt;

  const w = 1 - depth / CAMERA_DISTANCE_PX;
  return { x: spunX / w, y: tiltedY / w };
};

/**
 * Project a floor point after the camera has moved directly above it.
 *
 * With the tilt at zero every floor point has zero camera depth, so perspective contributes no division;
 * only the shared 45-degree spin remains. The splash exit uses this endpoint to turn the receding floor
 * into the screen-aligned diamond mosaic that hands off to the flat application UI.
 */
export const projectFlatFloorPoint = (point: Pick<Point3, 'x' | 'y'>): Point2 => ({
  x: point.x * cosSpin - point.y * sinSpin,
  y: point.x * sinSpin + point.y * cosSpin,
});

/**
 * How far above the origin the horizon sits on screen, in pixels.
 *
 * Floor points receding from the viewer crowd toward this line and never cross it, so it is a hard
 * ceiling on how much of the screen a floor can cover no matter how far it is extended. At this camera
 * it is `distance / tan(tilt)`, which is why the splash fades the floor out below it rather than trying
 * to reach the top of a tall window.
 */
export const HORIZON_RISE_PX = CAMERA_DISTANCE_PX / Math.tan(CAMERA_TILT_DEG * RAD);

export interface FloorReach {
  /** Screen pixels the far corner rises above the origin. Always below `HORIZON_RISE_PX`. */
  readonly farRise: number;
  /** Screen pixels the near corner falls below the origin. */
  readonly nearDrop: number;
  /** Screen pixels from the origin to the left and right corners. Equal, since the spin is 45°. */
  readonly halfWidth: number;
}

/**
 * The projected outline of a floor rectangle: a quadrilateral.
 *
 * Only the four corners are needed, and that is exact rather than an approximation: a projective map
 * takes straight lines to straight lines, so the image of a rectangle is a quadrilateral. An earlier
 * version sampled points along the boundary to find the same four points.
 *
 * `far` and `near` are the rectangle's extents along the floor axes, away from and toward the viewer.
 * They differ because a receding floor needs far more room behind the origin than in front of it, and a
 * rectangle stretched equally in both directions would push its near corner through the camera.
 */
const floorOutline = (far: number, near: number): Point2[] => [
  projectPoint({ x: -far, y: -far, z: 0 }),
  projectPoint({ x: near, y: -far, z: 0 }),
  projectPoint({ x: near, y: near, z: 0 }),
  projectPoint({ x: -far, y: near, z: 0 }),
];

/**
 * How much screen a floor rectangle covers, measured from the origin.
 *
 * The extremes of a quadrilateral are its vertices, so this is the outline's corners and nothing else.
 */
export const floorReach = (far: number, near: number): FloorReach => {
  const corners = floorOutline(far, near);

  return {
    farRise: -Math.min(...corners.map((corner) => corner.y)),
    nearDrop: Math.max(...corners.map((corner) => corner.y)),
    halfWidth: Math.max(...corners.map((corner) => Math.abs(corner.x))),
  };
};

/**
 * The largest circle centred on the origin that stays inside the floor's projected outline.
 *
 * The splash needs this because the projected floor is a quadrilateral and a window is a rectangle, so
 * the floor cannot cover the corners of the screen. Inside this radius the screen is paved with floor
 * cells and nothing else has to cover it; outside it, something does. The reach numbers are no help
 * here — they are the outline's furthest points, and the question is about its nearest edge.
 */
export const floorInscribedRadius = (far: number, near: number): number => {
  const corners = floorOutline(far, near);

  return Math.min(...corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length] as Point2;
    const dx = next.x - corner.x;
    const dy = next.y - corner.y;
    // Perpendicular distance from the origin to the edge's line. The origin is inside the outline, so
    // the nearest point on each edge is within the segment and the line distance is the segment distance.
    return Math.abs(dx * corner.y - dy * corner.x) / Math.hypot(dx, dy);
  }));
};

/** The CSS transform that puts a flat element into the floor plane under this same camera. */
export const CAMERA_FLOOR_TRANSFORM =
  `perspective(${CAMERA_DISTANCE_PX}px) rotateX(${CAMERA_TILT_DEG}deg) rotateZ(${CAMERA_SPIN_DEG}deg)`;

/** Same camera after it has moved overhead, with an identical transform list for smooth interpolation. */
export const CAMERA_FLAT_FLOOR_TRANSFORM =
  `perspective(${CAMERA_DISTANCE_PX}px) rotateX(0deg) rotateZ(${CAMERA_SPIN_DEG}deg)`;
