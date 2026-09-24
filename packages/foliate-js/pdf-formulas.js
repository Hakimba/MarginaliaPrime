// Display formulas of a PDF page, found from its text items.
//
// The reader picks a formula with one click instead of dragging a selection
// over glyphs that are scattered, stacked and out of order.  Everything here
// is geometry and font names, computed once per page from items pdf.js has
// already read, so the page itself costs nothing more.
//
// Signals, measured on a LaTeX book (Mathematics for Machine Learning):
//
//   * the running text is set in one font (Charter there, Computer Modern
//     Roman in a plain LaTeX book) and mathematics in others (CMMI, CMSY,
//     CMEX…): a display line has mathematical glyphs and no word of prose;
//   * an equation number such as "(6.100)" is set in the text font, flush with
//     the right edge of the text column;
//   * a display spreads over several baselines (numerator, fraction bar,
//     denominator, limits), so neighbouring display lines form one block, and
//     a block holding several numbers holds several equations;
//   * a big operator or delimiter (CMEX) has its baseline at the top of the
//     glyph and hangs about twice its font size below it: the lower limit of an
//     integral sits under the integral, not on the equation below.
//
// Items are `{ x, y, w, h, str, rot, font }` in PDF points, `y` being the
// baseline growing downwards and `font` the font's real name ("CMMI10").

import { orderItems } from './pdf-text-order.js'

/** Fonts that only set mathematics. */
const MATH_FONT = new RegExp([
    'CMMI', 'CMSY', 'CMEX', 'CMBSY', 'CMMIB', 'MSAM', 'MSBM', 'EUFM', 'EURM', 'EUSM', 'EUEX',
    'RSFS', 'dsrom', 'bbold', 'bbm', 'stmary', 'wasy', 'esint', 'txsy', 'txex', 'txmi', 'pxsy',
    'pxex', 'pxmi', 'lmmi', 'lmsy', 'lmex', 'LMMath', 'LatinModernMath', 'NewCMMath',
    'STIX\\w*Math', 'CambriaMath', 'XITSMath', 'FiraMath', 'TeXGyre\\w*Math', 'Asana',
].join('|'), 'i')

/** TeX's roman fonts: mathematics when the running text is set in something else. */
const TEX_ROMAN = /CMR\d|CMBX|CMSS|LMRoman|lmr\d|SFRM/i

/** Big operators and delimiters: the glyph hangs below its baseline. */
const HANGING = /CMEX|lmex|txex|pxex|esint/i

const EQUATION_NUMBER = /^\(\s*[A-Z]?\d+(?:[.\-–]\d+)*[a-z]?\s*\)$/

/** A word of prose: four letters in a row. "exp", "sin", "for" are not. */
const PROSE_WORD = /\p{L}{4,}/u

/** A line opening on a word ("for all", "and", "where") is prose, operators aside. */
const LEADING_WORD = /^\p{L}{2,}/u
const OPERATOR_NAME = /^(exp|log|ln|lg|sin|cos|tan|sinh|cosh|tanh|det|tr|max|min|sup|inf|lim|arg|diag|rank|span|dim|ker|im|Pr|var|cov|mod|gcd|sgn|erf)\b/

/** The one-word label of a row in a labelled system: "prior", "likelihood". */
const LABEL = /^\p{L}{4,}:?$/u

/** Punctuation only: the dots of a matrix or a system, set in the text font. */
const NEUTRAL = /^[^\p{L}\p{N}]*$/u

const baseName = (font) => (font || '').replace(/^[A-Z]{6}\+/, '')

const visible = (item) => typeof item.str === 'string' && item.str.trim().length > 0

/** A radical sign hangs below its baseline too, whatever its font. */
const hangs = (item) => HANGING.test(item.font) || item.str.trim() === '√'

/** Vertical extent of a glyph run, from its baseline and font size. */
const extent = (item) => hangs(item)
    ? { top: item.y - 0.1 * item.h, bottom: item.y + 2.2 * item.h }
    : { top: item.y - 0.78 * item.h, bottom: item.y + 0.22 * item.h }

/**
 * Top and bottom of a set of glyphs for drawing its box. A delimiter's real
 * depth is unknown (a matrix bracket is built of pieces), so hanging glyphs
 * may only reach a little past the rest; the full depth is kept for telling
 * two equations apart, where the lower limit of an integral must stay with it.
 */
const bounds = (items) => {
    const plain = items.filter((item) => !hangs(item))
    const hanging = items.filter((item) => hangs(item))
    if (!plain.length) {
        return {
            top: Math.min(...hanging.map((item) => extent(item).top)),
            bottom: Math.max(...hanging.map((item) => item.y + 1.2 * item.h)),
        }
    }
    const inkTop = Math.min(...plain.map((item) => extent(item).top))
    const inkBottom = Math.max(...plain.map((item) => extent(item).bottom))
    let top = inkTop
    let bottom = inkBottom
    for (const item of hanging) {
        const span = extent(item)
        top = Math.min(top, Math.max(span.top, inkTop - 0.3 * item.h))
        bottom = Math.max(bottom, Math.min(span.bottom, inkBottom + 0.3 * item.h))
    }
    return { top, bottom }
}

/**
 * Find the display formulas of a page.
 *
 * Returns zones `{ x, y, w, h, label, number, text }` in PDF points (top-left
 * origin), in reading order. `label` is the equation number when there is one.
 *
 * @returns {{ x: number, y: number, w: number, h: number,
 *   label: string, number: string, text: string }[]}
 */
export const detectFormulas = (rawItems, pageWidth) => {
    const items = rawItems
        .filter((item) => visible(item) && !item.rot)
        .map((item) => ({ ...item, font: baseName(item.font) }))
    if (items.length < 5 || !items.some((item) => item.font)) return []

    const { lines, textHeight } = orderItems(items, pageWidth)

    // The running text's font: the one carrying most characters at text size.
    const weight = new Map()
    for (const item of items) {
        if (Math.abs(item.h - textHeight) > 0.6) continue
        weight.set(item.font, (weight.get(item.font) ?? 0) + item.str.trim().length)
    }
    const bodyFont = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
    const romanIsMath = !TEX_ROMAN.test(bodyFont)
    const isMath = (item) => MATH_FONT.test(item.font)
        || (romanIsMath && TEX_ROMAN.test(item.font))

    const bodyLines = lines.filter((line) => line.zone === 'body')
    const textItems = bodyLines.flatMap((line) => line.items)
        .filter((item) => Math.abs(item.h - textHeight) <= 0.6 && item.font === bodyFont)
    if (!textItems.length) return []
    const columnLeft = Math.min(...textItems.map((item) => item.x))
    const columnRight = justifiedRight(bodyLines, textItems)

    // Numbers standing on a line of their own, between the rows they number.
    const loneNumbers = bodyLines.map((line) => {
        const shown = line.items.filter(visible)
        const number = equationNumber(shown, isMath, columnRight)
        // Pieces of a tall delimiter and scripts of the rows around may share
        // its baseline.
        return number && shown.every((item) => number.items.includes(item) || hangs(item)
            || item.h < 0.8 * textHeight) ? line.baseY : null
    }).filter((y) => y !== null)

    // Classify each body line: display candidate or prose.
    const described = bodyLines.map((line) => {
        const shown = line.items.filter(visible)
        const number = equationNumber(shown, isMath, columnRight)
        let content = number ? shown.filter((item) => !number.items.includes(item)) : shown
        // "Product rule:  (fg)' = f'g + fg'   (5.29)": a numbered line may open
        // on a label; the formula is what follows it. So may the rows of a
        // labelled system set well in from the text ("prior  p(θ) = …"),
        // whose number can sit on a line of its own.
        const setIn = content.length > 0 && content[0].x > columnLeft + 1.5 * textHeight
            && LABEL.test(content[0].str.trim()) && !isMath(content[0])
            && loneNumbers.some((y) => Math.abs(y - line.baseY) <= 1.5 * textHeight)
        if (number || setIn) {
            const firstMath = content.findIndex(isMath)
            const rest = content.slice(firstMath)
            if (firstMath > 0 && !rest.some((item) => !isMath(item) && PROSE_WORD.test(item.str))) {
                content = rest
            }
        }
        const mathChars = content.filter(isMath)
            .reduce((total, item) => total + item.str.trim().length, 0)
        const first = content[0]
        const lead = first && !isMath(first) && LEADING_WORD.test(first.str.trim())
            && !OPERATOR_NAME.test(first.str.trim())
        const prose = lead || content.some((item) => !isMath(item) && PROSE_WORD.test(item.str))
        const neutral = content.length > 0
            && content.every((item) => !isMath(item) && NEUTRAL.test(item.str))
        const left = content.length ? Math.min(...content.map((item) => item.x)) : columnLeft
        const indented = left > columnLeft + 0.5 * textHeight
        // A display is set at text size; the lettering of a plot (legend,
        // ticks), often in the same mathematical fonts, is set smaller.
        const tallest = content.length ? Math.max(...content.map((item) => item.h)) : 0
        const mathy = mathChars > 0 && !prose && content.length > 0 && tallest >= 0.9 * textHeight
        return {
            line, number, content, neutral, mathy, prose,
            display: mathy && (indented || !!number),
            left,
            right: content.length ? Math.max(...content.map((item) => item.x + item.w)) : left,
            ...(content.length ? bounds(content) : { top: Infinity, bottom: -Infinity }),
        }
    }).sort((a, b) => a.line.baseY - b.line.baseY)

    // The rows of a matrix set inside a sentence ("For A = [1 2; 3 2], we
    // obtain") lie above and below its text line, not on their own lines:
    // glyphs overlapping a line of prose belong to it, and so do glyphs
    // overlapping those. A display is set apart from the text by a skip and
    // never overlaps it. Hanging delimiters are left out of the test.
    const plainSpan = (entry) => {
        const plain = entry.content.filter((item) => !hangs(item))
        if (!plain.length) return null
        return {
            top: Math.min(...plain.map((item) => extent(item).top)),
            bottom: Math.max(...plain.map((item) => extent(item).bottom)),
        }
    }
    // Only a line of running text ties: one starting at the column's edge (a
    // paragraph indent aside) with words at text size. Not the "otherwise" of
    // a case split, nor a margin note run into the line of a limit.
    const runningText = (entry) => entry.prose && entry.content.length
        && entry.left <= columnLeft + 1.5 * textHeight
        && entry.content.some((item) => !isMath(item) && PROSE_WORD.test(item.str)
            && Math.abs(item.h - textHeight) <= 0.6)
    const tied = described.filter(runningText)
    for (let grown = true; grown;) {
        grown = false
        for (const entry of described) {
            if (!entry.mathy || tied.includes(entry)) continue
            const span = plainSpan(entry)
            if (!span) continue
            const touches = tied.some((other) => {
                const theirs = plainSpan(other)
                return theirs && entry.left < other.right && entry.right > other.left
                    && span.top < theirs.bottom - 1.5 && theirs.top < span.bottom - 1.5
            })
            if (touches) {
                entry.display = false
                entry.mathy = false
                tied.push(entry)
                grown = true
            }
        }
    }

    // A display too wide to be indented starts at the column's edge: a line of
    // mathematics without prose touching a display, or sitting on a number
    // pushed to the next line, is one.
    const near = (a, b) => b && Math.abs(
        (a.top < b.top ? b.top - a.bottom : a.top - b.bottom)) <= 0.9 * textHeight
    for (let pass = 0; pass < 2; pass += 1) {
        described.forEach((entry, i) => {
            if (entry.display || !entry.mathy) return
            const around = [described[i - 1], described[i + 1]]
            if (around.some((other) => other && near(entry, other.content.length ? other : {
                top: other.number ? other.number.y - 0.78 * other.number.h : Infinity,
                bottom: other.number ? other.number.y + 0.22 * other.number.h : -Infinity,
            }) && (other.display || (other.number && !other.content.length)))) {
                entry.display = true
            }
        })
    }

    // Neighbouring display lines form a block; a line of prose running across
    // it closes it. A margin note beside it does not: it is not a body line.
    const blocks = []
    let current = null
    for (const entry of described) {
        // A display too wide for its number gets it on the next line.
        if (entry.number && !entry.content.length) {
            const below = entry.number.y - 0.78 * entry.number.h - current?.bottom
            if (current && below <= 0.9 * textHeight
                && !current.entries.some((e) => e.number)) current.entries.push(entry)
            continue
        }
        if (entry.neutral) {
            if (current && entry.top - current.bottom <= 0.9 * textHeight) {
                current.entries.push(entry)
                current.bottom = Math.max(current.bottom, entry.bottom)
            }
            continue
        }
        if (!entry.display) {
            const crosses = current && entry.content.length
                && Math.min(...entry.content.map((i) => i.x)) < current.right
                && Math.max(...entry.content.map((i) => i.x + i.w)) > current.left
            if (crosses) current = null
            continue
        }
        if (current && entry.top - current.bottom <= 0.9 * textHeight) {
            current.entries.push(entry)
            current.left = Math.min(current.left, entry.left)
            current.right = Math.max(current.right, entry.right)
            current.bottom = Math.max(current.bottom, entry.bottom)
            continue
        }
        current = { entries: [entry], left: entry.left, right: entry.right, bottom: entry.bottom }
        blocks.push(current)
    }

    // Small lettering classified as a graphic (limits, stacked scripts) that
    // lies inside or against a block belongs to it.
    const loose = lines.filter((line) => line.zone === 'figure').flatMap((line) => line.items)

    // Each goes to the nearest block only, measured on the glyphs' full depth:
    // the lower limit under an integral is nearer the integral than the
    // equation just below, which it may even touch.
    const reach = (block) => {
        const glyphs = block.entries.flatMap((entry) => entry.content)
        return {
            top: Math.min(...glyphs.map((item) => extent(item).top)),
            bottom: Math.max(...glyphs.map((item) => extent(item).bottom)),
        }
    }
    const spans = new Map(blocks.map((block) => [block, reach(block)]))
    const owned = new Map()
    const proseSpans = tied.map(plainSpan).filter(Boolean)
        .map((span, i) => ({ ...span, left: tied[i].left, right: tied[i].right }))
    for (const item of loose) {
        const { top, bottom } = extent(item)
        // A small glyph within a line of text (the slash of a ≠) is the text's.
        if (proseSpans.some((span) => item.x < span.right && item.x + item.w > span.left
            && top < span.bottom && bottom > span.top)) continue
        let best = null
        let bestDistance = 0.8 * textHeight
        for (const block of blocks) {
            if (item.x >= block.right + 2 || item.x + item.w <= block.left - 2) continue
            const span = spans.get(block)
            const distance = Math.max(0, span.top - bottom, top - span.bottom)
            if (distance < bestDistance) {
                best = block
                bestDistance = distance
            }
        }
        if (best) owned.set(best, [...(owned.get(best) ?? []), item])
    }

    const zones = []
    for (const block of blocks) {
        let groups = [block.entries.flatMap((entry) => entry.content)]
        const numbered = block.entries.filter((entry) => entry.number)
        const numbers = numbered.map((entry) => entry.number)
        groups[0].push(...(owned.get(block) ?? []))
        if (numbered.length > 1) groups = splitAtGaps(groups[0], numbered.map((e) => e.line.baseY))
        groups.forEach((group, index) => {
            const zone = toZone(group, numbers.length > 1 ? numbers[index] : numbers[0])
            // A lone symbol set apart is not worth a chip, and delimiters alone
            // (the brackets of a matrix whose rows belong to a sentence) are
            // no formula.
            const mathChars = group.filter((item) => isMath(item) && !hangs(item))
                .reduce((t, i) => t + i.str.trim().length, 0)
            if (zone && mathChars >= 3) zones.push(zone)
        })
    }
    return separate(zones)
}

/**
 * Right edge of the text column: the edge most full lines of text end on. The
 * longest line is no guide, a line of justified text can overrun the column.
 */
const justifiedRight = (bodyLines, textItems) => {
    const ends = new Map()
    const set = new Set(textItems)
    for (const line of bodyLines) {
        const text = line.items.filter((item) => set.has(item))
        const chars = text.reduce((total, item) => total + item.str.length, 0)
        if (chars < 40) continue
        const end = Math.round(Math.max(...text.map((item) => item.x + item.w)))
        ends.set(end, (ends.get(end) ?? 0) + 1)
    }
    if (!ends.size) return Math.max(...textItems.map((item) => item.x + item.w))
    return [...ends].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]
}

/**
 * The equation number closing a line, as one item: pdf.js can split "(2.10)"
 * into "(2.10" and ")", so adjacent items of the text font are joined first.
 */
const equationNumber = (shown, isMath, columnRight) => {
    const sorted = [...shown].sort((a, b) => a.x - b.x)
    const last = sorted[sorted.length - 1]
    if (!last || isMath(last) || last.x + last.w < columnRight - 3) return null
    const parts = [last]
    for (let i = sorted.length - 2; i >= 0 && parts.length < 4; i -= 1) {
        const item = sorted[i]
        if (isMath(item) || parts[0].x - (item.x + item.w) > 1.5) break
        parts.unshift(item)
    }
    // The shortest run ending the line that reads as a number.
    for (let start = parts.length - 1; start >= 0; start -= 1) {
        const run = parts.slice(start)
        const str = run.map((item) => item.str).join('').trim()
        if (EQUATION_NUMBER.test(str)) {
            return { items: run, str, x: run[0].x, y: last.y, h: last.h,
                w: last.x + last.w - run[0].x }
        }
    }
    return null
}

/**
 * Cut a block holding several numbered equations: between two consecutive
 * numbers, at the widest vertical gap between glyphs.
 */
const splitAtGaps = (group, baselines) => {
    const cuts = []
    for (let i = 0; i + 1 < baselines.length; i += 1) {
        const from = baselines[i]
        const to = baselines[i + 1]
        const spans = group.map(extent)
            .filter((span) => span.bottom > from - 1 && span.top < to + 1)
            .sort((a, b) => a.top - b.top)
        let reach = from
        let best = { size: -Infinity, at: (from + to) / 2 }
        for (const span of spans) {
            if (span.top > reach && span.top - reach > best.size && span.top < to) {
                best = { size: span.top - reach, at: (reach + span.top) / 2 }
            }
            reach = Math.max(reach, span.bottom)
        }
        cuts.push(best.at)
    }
    const groups = baselines.map(() => [])
    for (const item of group) {
        const { top, bottom } = extent(item)
        const middle = (top + bottom) / 2
        let index = 0
        while (index < cuts.length && middle > cuts[index]) index += 1
        groups[index].push(item)
    }
    return groups
}

const PAD = 3

const toZone = (group, number) => {
    if (!group.length) return null
    const left = Math.min(...group.map((item) => item.x))
    const right = Math.max(...group.map((item) => item.x + item.w))
    const { top, bottom } = bounds(group)
    const plain = group.filter((item) => !hangs(item))
    const label = number ? number.str.trim() : ''
    return {
        x: left - PAD, y: top - PAD, w: right - left + 2 * PAD, h: bottom - top + 2 * PAD,
        label, number: label, text: groupText(group) + (label ? ` ${label}` : ''),
        // Where the glyphs of known height end, for separating neighbours.
        inkTop: plain.length ? Math.min(...plain.map((item) => extent(item).top)) : top,
        inkBottom: plain.length ? Math.max(...plain.map((item) => extent(item).bottom)) : bottom,
    }
}

/**
 * Two zones one above the other must not overlap: the depth of a bracket is
 * only estimated. They are cut halfway between their glyphs of known height.
 */
const separate = (zones) => {
    const sorted = [...zones].sort((a, b) => a.y - b.y)
    for (let i = 0; i + 1 < sorted.length; i += 1) {
        const upper = sorted[i]
        for (let j = i + 1; j < sorted.length; j += 1) {
            const lower = sorted[j]
            const side = upper.x < lower.x + lower.w && lower.x < upper.x + upper.w
            if (!side || upper.y + upper.h <= lower.y) continue
            const cut = (Math.min(upper.inkBottom, lower.inkTop) + Math.max(upper.inkBottom, lower.inkTop)) / 2
            if (cut <= upper.y || cut >= lower.y + lower.h) continue
            upper.h = Math.min(upper.y + upper.h, cut) - upper.y
            const bottom = lower.y + lower.h
            lower.y = Math.max(lower.y, cut)
            lower.h = bottom - lower.y
        }
    }
    return zones.map(({ inkTop, inkBottom, ...zone }) => zone)
}

/** The glyphs of a zone as extracted text, line by line: a fallback for the model. */
const groupText = (group) => {
    const rows = []
    for (const item of [...group].sort((a, b) => a.y - b.y || a.x - b.x)) {
        const row = rows[rows.length - 1]
        if (row && Math.abs(item.y - row.y) <= 1.5) row.items.push(item)
        else rows.push({ y: item.y, items: [item] })
    }
    return rows.map((row) => row.items.sort((a, b) => a.x - b.x)
        .map((item) => item.str.trim()).join(' ')).join('\n')
}
