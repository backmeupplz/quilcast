/** The image viewer's zoom (ui.tsx Lightbox): the picture at `z` times its fitted size, its middle moved `x`, `y` px
 *  from the screen's. Points here are measured from the screen's middle, where the fitted picture sits. */
export type Zoom = { z: number; x: number; y: number }
type Pt = { x: number; y: number }

export const FIT: Zoom = { z: 1, x: 0, y: 0 }
export const MAX_ZOOM = 4
// a double tap's
export const TAP_ZOOM = 2.5

const within = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n)) || 0 // (no -0)

/** `v` scaled to `z` about the point `p`, so the spot of the picture under `p` ends up under `to`: a double tap's spot
 *  stays put, a pinch's follows the fingers' middle. */
export function zoomAt(v: Zoom, z: number, p: Pt, to: Pt = p): Zoom {
  z = within(z, 1, MAX_ZOOM)
  return { z, x: to.x - (z * (p.x - v.x)) / v.z, y: to.y - (z * (p.y - v.y)) / v.z }
}

/** `v` kept from moving the picture's edge in past the screen's: the picture fits in `w`×`h` px on a `sw`×`sh` px
 *  screen. A side it doesn't fill stays in the middle; below 1× it fits again. */
export function bound(v: Zoom, w: number, h: number, sw: number, sh: number): Zoom {
  const z = within(v.z, 1, MAX_ZOOM)
  const lx = Math.max(0, (z * w - sw) / 2), ly = Math.max(0, (z * h - sh) / 2)
  return { z, x: within(v.x, -lx, lx), y: within(v.y, -ly, ly) }
}
