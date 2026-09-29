// Vertical fit of a passage's image to the ink of its lines.
//
// The boxes of a PDF text layer do not match the glyphs: pdf.js places a span
// from the font's ascent over the font size, so the box of a line starts above
// its capitals and stops above its descenders.  Measured on a real book, an
// image cut on those boxes kept a sliver of the line above and cut the indices
// of the selected line in half (σ₁ read as σ).  Whatever fixed margin is added,
// one of the two defects remains.
//
// So the image is drawn with room above and below, and cut again on the ink:
// the rows that hold ink form bands (a text line, a fraction bar, the limits
// of an integral), and a band belongs to the passage when most of it lies
// inside the boxes of the selection.  The line above, of which only the
// descenders reach into the boxes, does not; the indices hanging below the
// selected line, joined to it by their ink, do.

/**
 * Rows of an RGBA image that hold ink, as a boolean per row, measured between
 * columns `x0` and `x1` only: the side margins may hold a margin note or the
 * edge of a neighbouring column, set at other heights. A column inked almost
 * all the way down is a rule, the frame of a box or a shaded background, not
 * text: it would join every row into one band, and is left out.
 */
export const inkRows = (data, width, height, threshold = 200, x0 = 0, x1 = width) => {
    const dark = (x, y) => {
        const i = (y * width + x) * 4
        return Math.min(data[i], data[i + 1], data[i + 2]) < threshold
    }
    const from = Math.max(0, x0)
    const to = Math.min(width, x1)
    const skip = new Set()
    for (let x = from; x < to; x++) {
        let inked = 0
        for (let y = 0; y < height; y++) if (dark(x, y)) inked++
        if (inked > 0.85 * height) skip.add(x)
    }
    const rows = new Array(height).fill(false)
    for (let y = 0; y < height; y++) {
        for (let x = from; x < to; x++) {
            if (!skip.has(x) && dark(x, y)) {
                rows[y] = true
                break
            }
        }
    }
    return rows
}

/** Maximal runs of inked rows, as { start, end } (end exclusive). */
export const inkBands = rows => {
    const bands = []
    let start = -1
    rows.forEach((ink, y) => {
        if (ink && start < 0) start = y
        if (!ink && start >= 0) {
            bands.push({ start, end: y })
            start = -1
        }
    })
    if (start >= 0) bands.push({ start, end: rows.length })
    return bands
}

/**
 * The rows to keep, [top, bottom), given the inked rows and the rows the
 * selection's boxes cover. A band is kept when most of it is inside the boxes,
 * or when it reaches `guard` rows deep into them: two lines set so tight that
 * their ink touches make one band, and the selected one must not be lost with
 * the other. Null when no band belongs to the selection: a scan whose every
 * row holds some noise, or a selection of blanks.
 */
export const fitRows = (rows, coreTop, coreBottom, pad = 0, guard = 0) => {
    const deepTop = coreTop + guard
    const deepBottom = coreBottom - guard
    const kept = inkBands(rows).filter(({ start, end }) => {
        const inside = Math.min(end, coreBottom) - Math.max(start, coreTop)
        if (inside <= 0) return false
        return inside >= 0.5 * (end - start)
            || (guard > 0 && Math.min(end, deepBottom) > Math.max(start, deepTop))
    })
    if (!kept.length) return null
    // Ink from edge to edge of the drawing: nothing tells the lines apart
    // (a dark page, a scan with noise). The boxes are the better guess.
    if (kept[0].start === 0 && kept[kept.length - 1].end === rows.length) return null
    // The padding runs over blank rows only: it must not bring in the top of
    // an equation number set just below.
    let top = kept[0].start
    while (top > 0 && kept[0].start - top < pad && !rows[top - 1]) top--
    let bottom = kept[kept.length - 1].end
    while (bottom < rows.length && bottom - kept[kept.length - 1].end < pad && !rows[bottom]) bottom++
    return { top, bottom }
}
