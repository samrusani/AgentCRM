// The capture mark, shared by the button and the capture panel header.
const SVG_NS = 'http://www.w3.org/2000/svg';

/** One filled rect in the 100 unit icon box. */
function rect(x: number, y: number, w: number, h: number): SVGRectElement {
  const el = document.createElementNS(SVG_NS, 'rect');
  for (const [name, value] of [['x', x], ['y', y], ['width', w], ['height', h]] as const) el.setAttribute(name, String(value));
  return el;
}

/**
 * The extension's capture mark (see scripts/icons.mjs): four corner brackets at 20% and 80% with arm 22% and
 * thickness 9%, and a centered 20% square dot. The field behind it is the button's own background. The `added`
 * state swaps the brackets for a check so the confirmation reads at a glance, in the same box.
 */
export function buildIcon(kind: 'mark' | 'check'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'currentColor');
  if (kind === 'check') {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M24 52 L43 70 L77 31');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '11');
    path.setAttribute('stroke-linecap', 'square');
    svg.append(path);
    return svg;
  }
  const lo = 20, hi = 80, arm = 22, t = 9;
  for (const [cx, sx] of [[lo, 1], [hi, -1]] as const) {
    for (const [cy, sy] of [[lo, 1], [hi, -1]] as const) {
      svg.append(rect(sx > 0 ? cx : cx - arm, sy > 0 ? cy : cy - t, arm, t));
      svg.append(rect(sx > 0 ? cx : cx - t, sy > 0 ? cy : cy - arm, t, arm));
    }
  }
  svg.append(rect(40, 40, 20, 20));
  return svg;
}
