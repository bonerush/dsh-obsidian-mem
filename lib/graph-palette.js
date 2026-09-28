/**
 * Obsidian's graph colour contract, and nothing else.
 *
 * app.js keeps its palette in `MQ` — eleven slot names mapped to the
 * `.graph-view.color-*` classes that declare them — and fills it in `testCSS()`
 * by asking the browser for the computed style of hidden probe elements. Each
 * slot therefore carries a colour *and* an opacity (`color-fill-unresolved` is
 * 50%, `color-arrow` 50%), and the host theme owns the values: that is how the
 * graph follows an Obsidian theme, and it is how this port follows DSH's.
 *
 * The table lives here rather than in the Canvas renderer so it can be tested on
 * its own and so the renderer stays inside its size budget.
 *
 * @module graph-palette
 */

/** Obsidian's `MQ`: slot name to the `.graph-view` class that declares it. */
export const COLOR_SLOTS = {
  fill: 'color-fill',
  fillFocused: 'color-fill-focused',
  fillTag: 'color-fill-tag',
  fillUnresolved: 'color-fill-unresolved',
  fillAttachment: 'color-fill-attachment',
  arrow: 'color-arrow',
  circle: 'color-circle',
  line: 'color-line',
  text: 'color-text',
  fillHighlight: 'color-fill-highlight',
  lineHighlight: 'color-line-highlight',
}

/** The grey Obsidian falls back to when a slot's declaration cannot be read. */
export const FALLBACK_RGB = 0x888888

const channels = (slot) => [(slot.rgb >> 16) & 255, (slot.rgb >> 8) & 255, slot.rgb & 255]

/**
 * Parse `#rgb`, `#rrggbb`, `rgb()` or `rgba()` into Obsidian's `{a, rgb}` shape.
 *
 * @param {unknown} value - a CSS colour as a browser or a colour input reports it.
 * @returns {{a: number, rgb: number}|null} the slot, or `null` when unreadable.
 */
export function parseColor(value) {
  const text = String(value ?? '').trim()
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu)
  if (hex !== null) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((char) => char + char).join('') : hex[1]
    return { a: 1, rgb: Number.parseInt(digits, 16) }
  }
  const match = text.match(/rgba?\(([^)]+)\)/u)
  if (match === null) return null
  const parts = match[1].split(',').map((part) => Number.parseFloat(part))
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null
  const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
  return {
    a: alpha,
    rgb: ((parts[0] & 255) << 16) | ((parts[1] & 255) << 8) | (parts[2] & 255),
  }
}

/**
 * Add the two string forms the Canvas API needs for one slot.
 *
 * @param {{a: number, rgb: number}} slot - a parsed slot.
 * @returns {{a: number, rgb: number, css: string, opaque: string}} the same slot with CSS forms.
 */
export function withCss(slot) {
  const [r, g, b] = channels(slot)
  return { ...slot, css: `rgba(${r}, ${g}, ${b}, ${slot.a})`, opaque: `rgb(${r}, ${g}, ${b})` }
}

/**
 * A colour-group value from the settings panel, or the slot it falls back to.
 *
 * @param {unknown} value - the group's colour, usually `#rrggbb`.
 * @param {{a: number, rgb: number, css: string, opaque: string}} fallback - the slot to keep.
 * @returns {{a: number, rgb: number, css: string, opaque: string}} the colour to paint with.
 */
export function colorOf(value, fallback) {
  const parsed = parseColor(value)
  return parsed === null ? fallback : withCss(parsed)
}

/**
 * Resolve every slot from the host theme.
 *
 * The probe is appended to the panel's own root so the panel's scoped rules apply
 * (Obsidian appends to `document.body` for the same reason); a slot whose colour
 * cannot be parsed keeps `{a: 1, rgb: 0x888888}`, exactly as `testCSS()` does.
 *
 * @param {object} options - the document seam and the element to probe inside.
 * @param {Document} options.document - the document that creates and measures the probe.
 * @param {Window} options.win - the window whose `getComputedStyle` is authoritative.
 * @param {Element} options.host - the element the probes are appended to.
 * @returns {object} slot name to `{a, rgb, css, opaque}`.
 */
export function resolvePalette({ document, win, host }) {
  const palette = {}
  for (const [key, className] of Object.entries(COLOR_SLOTS)) {
    let slot = { a: 1, rgb: FALLBACK_RGB }
    const probe = document.createElement('div')
    probe.className = 'graph-view ' + className
    probe.setAttribute('aria-hidden', 'true')
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.pointerEvents = 'none'
    host.appendChild(probe)
    const style = win.getComputedStyle(probe)
    const parsed = parseColor(style.color)
    if (parsed !== null) {
      const opacity = Number.parseFloat(style.opacity)
      slot = { a: (Number.isFinite(opacity) ? opacity : 1) * parsed.a, rgb: parsed.rgb }
    }
    host.removeChild(probe)
    palette[key] = withCss(slot)
  }
  return palette
}
