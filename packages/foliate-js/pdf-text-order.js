// Reading order for a PDF page's text items.
//
// A PDF stores text in the order the producer emitted it, which is not the
// order a human reads it.  Two consequences, both measured on real books:
//
//   * items of a marginal column are interleaved with the body text, so a
//     selection dragged over a paragraph swallows the margin notes;
//   * around formulas the emission order jumps (matrix delimiters, indices,
//     exponents), so the DOM distance between two visually adjacent glyphs can
//     be hundreds of nodes — a three-pixel drag then selects a whole paragraph.
//
// Everything here works on plain boxes and is unit-agnostic: pass PDF points
// when building a document, CSS pixels when re-ordering a rendered text layer.
//
// An item is `{ x, y, w, h, str }` where `y` is the baseline (growing
// downwards) and `x` the left edge.  Any extra field is preserved, so callers
// can carry a DOM node or an index along.

/** Median of a numeric array; 0 for an empty one. */
const median = (values) => {
    if (!values.length) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Items that carry visible text; the rest is positioning noise. */
const isVisible = (item) => typeof item.str === 'string' && item.str.trim().length > 0

/**
 * Split the page into vertical text columns.
 *
 * A bin of the page's width counts how many text lines put ink in it.  Counting
 * lines rather than items is what makes a gutter visible: a single full-width
 * footer crosses it, but one line out of forty is noise, whereas the margin
 * column itself is fed by a dozen of them.
 *
 * Returns columns left to right, each with its x range and a `margin` flag.
 */
export const detectColumns = (items, pageWidth) => {
    const visible = items.filter(isVisible)
    const single = [{ from: -Infinity, to: Infinity, margin: false }]
    if (visible.length < 20) return single

    const width = pageWidth || Math.max(...visible.map((i) => i.x + i.w))
    if (!(width > 0)) return single

    const heights = visible.map((i) => i.h).filter((h) => h > 0)
    const bands = groupIntoLines(visible, median(heights) || 10)
    if (bands.length < 6) return single

    const BINS = 200
    const binWidth = width / BINS
    // Three bins ≈ 9pt on A4: wider than any word space, narrower than the
    // gutter of a marginal column (12pt on the book measured here).
    const gutterBins = 3
    const cover = new Array(BINS).fill(0)
    for (const band of bands) {
        const seen = new Set()
        for (const item of band.items) {
            if (!isVisible(item)) continue
            const from = Math.max(0, Math.floor(item.x / binWidth))
            const to = Math.min(BINS - 1, Math.floor((item.x + Math.max(item.w, binWidth / 2)) / binWidth))
            for (let b = from; b <= to; b++) seen.add(b)
        }
        for (const b of seen) cover[b]++
    }

    const busiest = Math.max(...cover)
    const floor = Math.max(1, busiest * 0.15)

    // One pass: a gap shorter than a gutter keeps the current run open, so the
    // spaces between words never split a column.
    const runs = []
    let current = null
    for (let b = 0; b < BINS; b++) {
        if (cover[b] > floor) {
            if (current && b - current.end <= gutterBins) current.end = b
            else {
                current = { start: b, end: b }
                runs.push(current)
            }
        }
    }
    if (runs.length < 2) return single

    // A narrow strip inside the page is not a column: equation numbers, a
    // figure's labels.  It belongs to the text on its left, where it will be
    // read at the end of its own line.  Only an edge column may be narrow.
    const widestRun = Math.max(...runs.map((r) => r.end - r.start + 1))
    const kept = runs.filter((run, index) => {
        if (index === 0 || index === runs.length - 1) return true
        if (run.end - run.start + 1 >= widestRun * 0.45) return true
        runs[index - 1].end = run.end
        return false
    })
    if (kept.length < 2) return single

    const columns = kept.map((run) => {
        const from = run.start * binWidth
        const to = (run.end + 1) * binWidth
        return { from, to, extent: to - from }
    })

    // A marginal column is narrow, sparse, and against a page edge: only the
    // first or last column can be one.  Two columns of comparable width are a
    // genuine two-column layout and both stay body text, read left to right.
    // Anything in between belongs to the body: a table's own gutters do not
    // show up here, being empty for its own rows only.
    const widest = Math.max(...columns.map((c) => c.extent))
    const isMargin = (c, index) =>
        (index === 0 || index === columns.length - 1) && c.extent < widest * 0.45
    return columns.map((c, index) => ({
        from: c.from,
        to: c.to,
        margin: isMargin(c, index),
    }))
}

/** Index of the column an item belongs to, by its horizontal centre. */
const columnOf = (item, columns) => {
    const centre = item.x + item.w / 2
    for (let i = 0; i < columns.length; i++) {
        if (centre >= columns[i].from && centre < columns[i].to) return i
    }
    // Outside every detected column: attach to the nearest one.
    let best = 0
    let bestDistance = Infinity
    for (let i = 0; i < columns.length; i++) {
        const distance = centre < columns[i].from
            ? columns[i].from - centre
            : centre - columns[i].to
        if (distance < bestDistance) {
            bestDistance = distance
            best = i
        }
    }
    return best
}

/**
 * The height of the page's running text: the most common item height, weighted
 * by how many characters it carries.  The median would be dragged around by
 * captions and footers, which are numerous but short.
 */
export const bodyHeight = (items) => {
    const weight = new Map()
    for (const item of items) {
        if (!isVisible(item) || !(item.h > 0)) continue
        const bucket = Math.round(item.h * 2) / 2
        weight.set(bucket, (weight.get(bucket) ?? 0) + item.str.trim().length)
    }
    let best = 0
    let bestWeight = -1
    for (const [height, chars] of weight) {
        if (chars > bestWeight) {
            bestWeight = chars
            best = height
        }
    }
    return best
}

/**
 * Whether a line is the lettering of a graphic rather than text to read.
 *
 * Axis ticks, legends and curve labels are set far smaller than the running
 * text and scattered across the plot; a caption, which is worth reading, is
 * only slightly smaller and fills its line.  Measured on the book at hand:
 * running text 10.5, captions and footers 8, plot lettering 4.5 to 6.5, laid
 * out with a tenth of the line covered in ink, sometimes turned on its side.
 */
export const isGraphicLine = (line, textHeight) => {
    const visible = line.items.filter(isVisible)
    if (!visible.length) return false
    const tallest = Math.max(...visible.map((item) => item.h))
    if (!(textHeight > 0) || tallest >= textHeight * 0.7) return false

    const chars = visible.reduce((total, item) => total + item.str.trim().length, 0)
    const left = Math.min(...visible.map((item) => item.x))
    const right = Math.max(...visible.map((item) => item.x + item.w))
    const ink = visible.reduce((total, item) => total + item.w, 0)
    const fill = right > left ? ink / (right - left) : 1
    const turned = visible.some((item) => item.rot)
    return turned || chars <= 25 || fill < 0.5
}

/**
 * Group items of one column into visual lines.
 *
 * Lines are cut on the baseline, with a tolerance taken from the page's median
 * text height: an exponent sits a few points above its base line and must stay
 * with it, while two rows of a matrix are farther apart and must not merge.
 */
export const groupIntoLines = (items, textHeight) => {
    const tolerance = Math.min(12, Math.max(3, textHeight * 0.7))
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
    const lines = []
    for (const item of sorted) {
        const line = lines[lines.length - 1]
        if (line && Math.abs(item.y - line.baseY) <= tolerance) {
            line.items.push(item)
            // The tallest item of the line carries its baseline: a run of
            // exponents must not drag the reference upwards.
            if (item.h > line.height && isVisible(item)) {
                line.height = item.h
                line.baseY = item.y
            }
            continue
        }
        lines.push({ baseY: item.y, height: item.h, items: [item] })
    }
    for (const line of lines) line.items.sort((a, b) => a.x - b.x)
    return lines
}

/**
 * Reading order for a whole page.
 *
 * Body columns come first, left to right, each read line by line; marginal
 * columns follow, so a selection over the body can never swallow a note and a
 * note can be selected on its own.
 */
export const orderItems = (items, pageWidth) => {
    const textHeight = bodyHeight(items) || median(items.filter(isVisible).map((i) => i.h)) || 10
    const columns = detectColumns(items, pageWidth)

    const buckets = columns.map(() => [])
    for (const item of items) buckets[columnOf(item, columns)].push(item)

    const grouped = []
    columns.forEach((column, index) => {
        for (const line of groupIntoLines(buckets[index], textHeight)) {
            const zone = column.margin
                ? 'margin'
                : isGraphicLine(line, textHeight)
                    ? 'figure'
                    : 'body'
            grouped.push({ ...line, zone, margin: zone === 'margin', column: index })
        }
    })

    // Body first, then the lettering of graphics, then the marginal notes: each
    // zone is a contiguous run, so a drag started in one can never sweep up
    // another, and the text of a page reads as a text and not as a heap.
    const lines = []
    for (const zone of ['body', 'figure', 'margin']) {
        for (const line of grouped) if (line.zone === zone) lines.push(line)
    }
    const order = []
    for (const line of lines) for (const item of line.items) order.push(item)
    return { order, lines, columns, textHeight }
}

/**
 * Text of one line, with the spaces the PDF only expresses as gaps.
 *
 * A LaTeX producer positions each word separately, so "matrix" and "A" can be
 * adjacent items with no space between them, which glued words together in the
 * text sent to the model.
 */
export const lineToText = (line, textHeight) => {
    const threshold = Math.max(1, textHeight * 0.18)
    let text = ''
    let previous = null
    for (const item of line.items) {
        const str = item.str ?? ''
        if (!str) continue
        if (previous) {
            const gap = item.x - (previous.x + previous.w)
            const glued = /\s$/.test(text) || /^\s/.test(str)
            if (!glued && gap > threshold) text += ' '
        }
        text += str
        previous = item
    }
    return text.replace(/\s+/g, ' ').trim()
}

/**
 * Consecutive lines of a marginal column that belong to the same note.
 *
 * A note wraps over three or four short lines; labelling each of them
 * separately would drown the text sent to the model in noise.  Measured on the
 * book at hand: lines of one note are one text height apart, whereas two notes
 * are farther apart — except when a keyword note happens to sit right under
 * the last line of another, hence the second test on the closing punctuation.
 */
export const groupMarginNotes = (lines, textHeight, zone = 'margin') => {
    const notes = []
    let previous = null
    for (const line of lines) {
        if ((line.zone ?? (line.margin ? 'margin' : 'body')) !== zone) continue
        const text = lineToText(line, textHeight)
        const continues =
            previous &&
            line.baseY - previous.line.baseY <= textHeight * 1.15 &&
            !/[.:;!?]$/.test(previous.text)
        if (continues) notes[notes.length - 1].lines.push(line)
        else notes.push({ lines: [line] })
        previous = { line, text }
    }
    return notes
}

/**
 * Page text in reading order: the text to read first, then the lettering of the
 * graphics and the marginal notes, each labelled, so the model can tell a gloss
 * or an axis tick from the sentence they sit next to.
 */
export const pageToText = (
    items,
    pageWidth,
    { marginLabel = 'note de marge', figureLabel = 'figure' } = {},
) => {
    const { lines, textHeight } = orderItems(items, pageWidth)
    const body = lines
        .filter((line) => line.zone === 'body')
        .map((line) => lineToText(line, textHeight))
        .filter(Boolean)
    const group = (zone) => groupMarginNotes(lines, textHeight, zone)
        .map((note) => note.lines.map((line) => lineToText(line, textHeight)).join(' ').trim())
        .filter(Boolean)
    const parts = [body.join('\n')]
    for (const [zone, label] of [['figure', figureLabel], ['margin', marginLabel]]) {
        const blocks = group(zone)
        if (blocks.length) parts.push(blocks.map((block) => `[${label}] ${block}`).join('\n'))
    }
    return parts.filter(Boolean).join('\n\n')
}

// ---------------------------------------------------------------------------
// Rendered text layer
// ---------------------------------------------------------------------------

/** Zone of a node inside a re-ordered text layer: body, figure or margin. */
export const zoneOf = (node) => {
    const el = node?.nodeType === 1 ? node : node?.parentElement
    return el?.closest?.('[data-zone]')?.getAttribute('data-zone') ?? 'body'
}

/**
 * Re-order a rendered pdf.js text layer into reading order.
 *
 * Nothing moves on screen: every span is absolutely positioned, so the DOM
 * order only decides what a drag of the mouse selects and what a copy yields.
 * Line breaks are re-cut on the visual lines, and whatever is not text to read
 * — a marginal column, the lettering of a graphic — is gathered at the end and
 * tagged, out of the body's way.
 */
export const applyReadingOrder = (container) => {
    const spans = Array.from(container.querySelectorAll('span')).filter(
        (span) => !span.classList.contains('markedContent') && span.firstChild,
    )
    if (spans.length < 2) return null

    const base = container.getBoundingClientRect()
    const items = spans.map((node) => {
        const rect = node.getBoundingClientRect()
        return {
            node,
            x: rect.left - base.left,
            y: rect.top - base.top,
            w: rect.width,
            h: rect.height,
            // pdf.js turns a rotated run with a custom property; an axis label
            // set on its side is a sure sign of a graphic.
            rot: parseFloat(node.style.getPropertyValue('--rotate')) || 0,
            str: node.textContent ?? '',
        }
    })

    const { lines, columns } = orderItems(items, base.width || undefined)

    // The <br> elements pdf.js emits follow the producer's line breaks, which
    // are not the visual ones; re-cut them on the lines just computed.
    for (const br of Array.from(container.querySelectorAll('br'))) br.remove()

    const doc = container.ownerDocument
    const fragment = doc.createDocumentFragment()
    for (const line of lines) {
        // A producer positions each word on its own, so nothing in the layer
        // holds the space between two words: it is recorded here, on the span
        // that follows the gap, for whoever reads the text of a selection.
        const threshold = Math.max(1, (line.height || 10) * 0.18)
        let previous = null
        for (const item of line.items) {
            if (line.zone === 'body') delete item.node.dataset.zone
            else item.node.dataset.zone = line.zone
            const spaced = previous
                && item.x - (previous.x + previous.w) > threshold
                && !/\s$/.test(previous.str)
                && !/^\s/.test(item.str)
            if (spaced) item.node.dataset.space = '1'
            else delete item.node.dataset.space
            fragment.append(item.node)
            if (item.str.trim()) previous = item
        }
        fragment.append(doc.createElement('br'))
    }
    const endOfContent = container.querySelector('.endOfContent')
    container.append(fragment)
    if (endOfContent) container.append(endOfContent)

    return {
        lines: lines.length,
        columns,
        margins: lines.filter((line) => line.zone === 'margin').length,
        figures: lines.filter((line) => line.zone === 'figure').length,
    }
}

/**
 * Keep a selection inside the zone it started in.
 *
 * Marginal spans sit at the end of the layer, so dragging from the body into
 * the margin would otherwise sweep up everything in between.  The selection is
 * clamped to the last (or first) span of the zone it was started in.
 */
export const clampSelectionToZone = (doc) => {
    const selection = doc.getSelection()
    if (!selection || selection.isCollapsed || !selection.anchorNode) return false
    const anchorZone = zoneOf(selection.anchorNode)
    if (anchorZone === zoneOf(selection.focusNode)) return false

    const container = (selection.anchorNode.nodeType === 1
        ? selection.anchorNode
        : selection.anchorNode.parentElement
    )?.closest('.textLayer')
    if (!container) return false

    const spans = Array.from(container.querySelectorAll('span')).filter(
        (span) => zoneOf(span) === anchorZone && span.firstChild,
    )
    if (!spans.length) return false

    const forwards =
        selection.anchorNode.compareDocumentPosition(selection.focusNode) &
        Node.DOCUMENT_POSITION_FOLLOWING
    const edge = forwards ? spans[spans.length - 1] : spans[0]
    const node = edge.firstChild
    try {
        selection.extend(node, forwards ? node.length ?? 0 : 0)
    } catch {
        return false
    }
    return true
}
