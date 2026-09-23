// Mouse selection over a PDF page, driven by the page's own geometry.
//
// The text of a PDF page is a heap of absolutely positioned spans.  Left to the
// browser, a drag selects everything lying between two DOM positions, and the
// DOM position under a point that falls in the gap between two lines is chosen
// with no regard for what is nearby: measured on a real book, releasing the
// mouse six pixels above a line put the caret in the running head, twenty lines
// away, so the whole page ended up selected.  That is the defect that makes
// selecting a formula, or a few words around one, close to impossible.
//
// So the browser's hit-testing is not used at all.  A point is resolved against
// the lines computed by the reading-order pass: the nearest line, then the
// nearest word of that line, then the character inside it.  A drag can only
// ever grow along the reading order, and never leaves the column it started in.

import { zoneOf } from './pdf-text-order.js'

/** How far from any text a press may be and still count as a selection. */
const GRAB_DISTANCE = 60

/** Lines of a re-ordered text layer, with the geometry of the moment. */
export const buildModel = (container) => {
    const lines = []
    let spans = []
    const flush = () => {
        const filled = spans.filter(span => (span.textContent ?? '').length)
        spans = []
        if (!filled.length) return
        const boxes = filled
            .map(node => {
                const rect = node.getBoundingClientRect()
                return {
                    node,
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom,
                    blank: !(node.textContent ?? '').trim(),
                }
            })
            // A layer measured before it is laid out gives every span a zero
            // box; every line then looks equally close to any point, the first
            // one wins, and a drag begun mid-page starts at the running head.
            .filter(box => box.bottom > box.top && box.right > box.left)
        if (!boxes.length) return
        lines.push({
            index: lines.length,
            zone: zoneOf(filled[0]),
            spans: boxes,
            top: Math.min(...boxes.map(b => b.top)),
            bottom: Math.max(...boxes.map(b => b.bottom)),
            left: Math.min(...boxes.map(b => b.left)),
            right: Math.max(...boxes.map(b => b.right)),
        })
    }
    for (const child of container.children) {
        if (child.tagName === 'BR') flush()
        else if (child.tagName === 'SPAN') spans.push(child)
    }
    flush()
    return lines
}

/** Vertical distance from a point to a line's band, zero when inside it. */
const distanceToLine = (line, y) =>
    y < line.top ? line.top - y : y > line.bottom ? y - line.bottom : 0

/** Character offset in a text node whose boundary is closest to x. */
const offsetAt = (doc, node, x) => {
    const text = node.nodeValue ?? ''
    if (!text.length) return 0
    const range = doc.createRange()
    for (let i = 0; i < text.length; i++) {
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        const rect = range.getBoundingClientRect()
        if (x < (rect.left + rect.right) / 2) return i
        if (x < rect.right) return i + 1
    }
    return text.length
}

/**
 * The text position a point means, on this page's terms.
 *
 * `zone` restricts the answer to the body or to the marginal column, so a drag
 * that wanders into the margin stops at the edge of the column it started in
 * instead of sweeping up everything in between.
 */
export const positionAt = (doc, lines, x, y, zone, anchorLine) => {
    const candidates = zone ? lines.filter(line => line.zone === zone) : lines
    if (!candidates.length) return null

    const dxTo = (line) => x < line.left ? line.left - x : x > line.right ? x - line.right : 0

    // Lines whose band holds the point come first: several can, because a
    // formula's glyphs and a superscript stretch a band over its neighbours.
    // Among those, the closest one horizontally and vertically wins — so
    // releasing past the end of a line stops at that line's end rather than
    // wandering into the formula beside it — and reading order settles a tie.
    const centreOf = (line) => (line.top + line.bottom) / 2

    // A hand shakes: while the pointer stays within half a line of the line the
    // drag started on, it means that line, even when it strays into the gap
    // above it — where a neighbour's subscripts would otherwise claim it.
    if (anchorLine) {
        const height = anchorLine.bottom - anchorLine.top
        if (distanceToLine(anchorLine, y) <= height * 0.5) {
            const span = nearestSpan(anchorLine, x)
            const at = span && positionInSpan(doc, span, x)
            if (at) return { ...at, line: anchorLine, distance: dxTo(anchorLine) }
        }
    }

    const onBand = candidates.filter(line => distanceToLine(line, y) === 0)
    let line = null
    if (onBand.length) {
        const score = (candidate) => dxTo(candidate) + Math.abs(centreOf(candidate) - y)
        line = onBand.reduce((best, candidate) => {
            if (!best) return candidate
            const difference = score(candidate) - score(best)
            if (Math.abs(difference) > 0.5) return difference < 0 ? candidate : best
            if (!anchorLine) return best
            const drift = Math.abs(candidate.index - anchorLine.index)
            const bestDrift = Math.abs(best.index - anchorLine.index)
            return drift < bestDrift ? candidate : best
        }, null)
    } else {
        let best = Infinity
        for (const candidate of candidates) {
            const distance = distanceToLine(candidate, y) * 4 + dxTo(candidate)
            if (distance < best) {
                best = distance
                line = candidate
            }
        }
    }
    if (!line) return null

    const span = nearestSpan(line, x)
    if (!span) return null
    const at = positionInSpan(doc, span, x)
    if (!at) return null
    const spanDistance = x < span.left ? span.left - x : x > span.right ? x - span.right : 0
    return {
        ...at,
        line,
        distance: distanceToLine(line, y) + dxTo(line) + spanDistance,
    }
}

/**
 * The word of a line whose box is closest to x.
 *
 * A PDF line often carries one whitespace item as wide as the line itself —
 * measured on the book at hand: a single space 262 points wide. Its box
 * contains every point of the line, so taking the first box that contains x
 * anchored every drag at the beginning of the line. A span with text wins over
 * a blank one, and a narrow box over a wide one.
 */
const nearestSpan = (line, x) => {
    const distance = (box) => x < box.left ? box.left - x : x > box.right ? x - box.right : 0
    let span = null
    let best = null
    for (const box of line.spans) {
        const score = [distance(box), box.blank ? 1 : 0, box.right - box.left]
        if (!span || score[0] < best[0]
            || (score[0] === best[0] && (score[1] < best[1]
                || (score[1] === best[1] && score[2] < best[2])))) {
            best = score
            span = box
        }
    }
    return span
}

/** Text node and offset a point means inside one word. */
const positionInSpan = (doc, span, x) => {
    const node = span.node.firstChild
    if (!node) return null
    const offset = x <= span.left
        ? 0
        : x >= span.right
            ? (node.nodeValue ?? '').length
            : offsetAt(doc, node, x)
    return { node, offset }
}

/** Whether a point falls on the current selection, within a couple of pixels. */
const isOnSelection = (doc, x, y) => {
    const selection = doc.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false
    for (const rect of selection.getRangeAt(0).getClientRects()) {
        if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) {
            return true
        }
    }
    return false
}

/** Whole word around a point, as a pair of positions. */
const wordAt = (doc, lines, x, y) => {
    const at = positionAt(doc, lines, x, y, null)
    if (!at) return null
    const text = at.node.nodeValue ?? ''
    const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'word' })
        : null
    if (!segmenter) return { from: { ...at, offset: 0 }, to: { ...at, offset: text.length } }
    for (const segment of segmenter.segment(text)) {
        const end = segment.index + segment.segment.length
        if (segment.index <= at.offset && end >= at.offset && segment.isWordLike) {
            return { from: { ...at, offset: segment.index }, to: { ...at, offset: end } }
        }
    }
    return { from: { ...at, offset: 0 }, to: { ...at, offset: text.length } }
}

/**
 * Take over mouse selection on a rendered PDF page.
 *
 * The geometry is measured at every press rather than kept around: a page is
 * re-rendered on each zoom, and the first render happens while the frame is
 * still hidden, when every rectangle measures zero.
 */
export const installGeometrySelection = (doc, container) => {
    if (container._marginaliaSelection) return container._marginaliaSelection

    let lines = []
    let anchor = null
    let zone = null
    // A press that landed on the current selection: it means a click on it
    // until the pointer actually moves.
    let pending = null
    let pressedAt = null

    const handle = { isGrabbing: () => anchor != null }
    container._marginaliaSelection = handle

    const apply = (focus) => {
        if (!anchor || !focus) return
        doc.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
    }

    // Only the browser's own selection is called off — and nothing else.
    // Preventing the default action of a pointer event would suppress the
    // compatibility mouse events with it, and the reader listens to those: no
    // more click to turn the page, and an annotation toolbar that never closes.
    doc.addEventListener('selectstart', (event) => {
        if (anchor) event.preventDefault()
    })

    container.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        anchor = null
        zone = null
        lines = buildModel(container)
        // Nothing measurable to aim at: leave the press to the browser rather
        // than selecting at random.
        if (lines.length < 2) return
        if (event.detail === 3) {
            // Triple click: the whole line.
            const at = positionAt(doc, lines, event.clientX, event.clientY, null)
            const spans = at?.line.spans
            const first = spans?.[0].node.firstChild
            const last = spans?.[spans.length - 1].node.firstChild
            if (first && last) {
                doc.getSelection()?.setBaseAndExtent(first, 0, last, (last.nodeValue ?? '').length)
            }
            return
        }
        if (event.detail > 1) return // the double click is handled on its own
        const at = positionAt(doc, lines, event.clientX, event.clientY, null)
        if (!at || at.distance > GRAB_DISTANCE) return // leave the press to panning

        pressedAt = { x: event.clientX, y: event.clientY }
        // Pressing on the selection keeps it: the reader clicks it to bring up
        // the annotation toolbar, and only a real move starts a new selection.
        if (isOnSelection(doc, event.clientX, event.clientY)) {
            pending = at
            return
        }
        start(at, event.pointerId)
    })

    const start = (at, pointerId) => {
        anchor = at
        zone = at.line.zone
        pending = null
        doc.getSelection()?.removeAllRanges()
        container.classList.add('selecting')
        try {
            container.setPointerCapture(pointerId)
        } catch {
            // Capture is a convenience; the listeners still fire without it.
        }
    }

    container.addEventListener('pointermove', (event) => {
        if (pending) {
            const moved = Math.abs(event.clientX - pressedAt.x) + Math.abs(event.clientY - pressedAt.y)
            if (moved < 4) return
            start(pending, event.pointerId)
        }
        if (!anchor) return
        apply(positionAt(doc, lines, event.clientX, event.clientY, zone, anchor.line))
    })

    const finish = (event) => {
        pending = null
        if (!anchor) return
        apply(positionAt(doc, lines, event.clientX, event.clientY, zone, anchor.line))
        anchor = null
        zone = null
        container.classList.remove('selecting')
        try {
            container.releasePointerCapture(event.pointerId)
        } catch {
            // Already released with the pointer.
        }
    }
    container.addEventListener('pointerup', finish)
    container.addEventListener('pointercancel', finish)

    // A double click takes the word: the gesture every reader expects, and it
    // was unusable before.
    container.addEventListener('dblclick', (event) => {
        lines = buildModel(container)
        const word = wordAt(doc, lines, event.clientX, event.clientY)
        if (!word) return
        doc.getSelection()?.setBaseAndExtent(
            word.from.node, word.from.offset, word.to.node, word.to.offset)
    })

    return handle
}
