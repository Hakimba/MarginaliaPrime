const pdfjsPath = path => `/vendor/pdfjs/${path}`

import { applyReadingOrder, clampSelectionToZone, orderItems, lineToText, groupMarginNotes }
    from './pdf-text-order.js'
import { installGeometrySelection } from './pdf-selection.js'

import '@pdfjs/pdf.min.mjs'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.min.mjs')

const fetchText = async url => await (await fetch(url)).text()

// WebKit has no async iteration on ReadableStream, so `page.getTextContent()`
// throws there ("undefined is not a function"): the stream has to be drained
// through a reader.
const readTextItems = async page => {
    const reader = page.streamTextContent().getReader()
    const items = []
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value?.items) items.push(...value.items)
    }
    return items
}

let textLayerBuilderCSS = null
let annotationLayerBuilderCSS = null

// Track active render tasks per iframe document to cancel superseded renders
const activeRenderTasks = new WeakMap()
// Generation counter per document to detect stale renders after async gaps
const renderGenerations = new WeakMap()

// Set up panning and selection event handlers once per iframe document
const setupPanningEvents = (doc) => {
    if (doc._readestEventsInitialized) return
    doc._readestEventsInitialized = true

    const container = doc.querySelector('.textLayer')
    if (!container) return

    let isPanning = false
    let startX = 0
    let startY = 0
    let scrollLeft = 0
    let scrollTop = 0
    let scrollParent = null

    const findScrollableParent = (element) => {
        let current = element
        while (current) {
            if (current !== document.body && current.nodeType === 1) {
                const style = window.getComputedStyle(current)
                const overflow = style.overflow + style.overflowY + style.overflowX
                if (/(auto|scroll)/.test(overflow)) {
                    if (current.scrollHeight > current.clientHeight ||
                        current.scrollWidth > current.clientWidth) {
                        return current
                    }
                }
            }
            if (current.parentElement) {
                current = current.parentElement
            } else if (current.parentNode && current.parentNode.host) {
                current = current.parentNode.host
            } else {
                break
            }
        }
        return window
    }

    container.onpointerdown = (e) => {
        // The geometry-driven selection gets first refusal on a press.
        if (doc._marginaliaSelection?.isGrabbing()) return
        const selection = doc.getSelection()
        const hasTextSelection = selection && selection.toString().length > 0

        const elementUnderCursor = doc.elementFromPoint(e.clientX, e.clientY)
        const hasTextUnderneath = elementUnderCursor &&
                             (elementUnderCursor.tagName === 'SPAN' || elementUnderCursor.tagName === 'P') &&
                             elementUnderCursor.textContent.trim().length > 0

        if (!hasTextUnderneath && !hasTextSelection) {
            isPanning = true
            startX = e.screenX
            startY = e.screenY

            const iframe = doc.defaultView?.frameElement
            if (iframe) {
                scrollParent = findScrollableParent(iframe)
                if (scrollParent === window) {
                    scrollLeft = window.scrollX || window.pageXOffset
                    scrollTop = window.scrollY || window.pageYOffset
                } else {
                    scrollLeft = scrollParent.scrollLeft
                    scrollTop = scrollParent.scrollTop
                }
            }
        } else {
            container.classList.add('selecting')
        }
    }

    container.onpointermove = (e) => {
        if (isPanning && scrollParent) {
            e.preventDefault()

            const dx = e.screenX - startX
            const dy = e.screenY - startY

            if (scrollParent === window) {
                window.scrollTo(scrollLeft - dx, scrollTop - dy)
            } else {
                scrollParent.scrollLeft = scrollLeft - dx
                scrollParent.scrollTop = scrollTop - dy
            }
        }
    }

    container.onpointerup = () => {
        if (isPanning) {
            isPanning = false
            scrollParent = null
        } else {
            container.classList.remove('selecting')
        }
    }

    container.onpointerleave = () => {
        if (isPanning) {
            isPanning = false
            scrollParent = null
        }
    }

    // The cursor is left alone: a hand that came and went over the page told
    // the reader nothing, since a click turns the page rather than grabbing it.
    doc.addEventListener('selectionchange', () => clampSelectionToZone(doc))
}

const render = async (page, doc, zoom) => {
    if (!doc) return

    // Increment generation to invalidate any in-progress render for this doc
    const generation = (renderGenerations.get(doc) || 0) + 1
    renderGenerations.set(doc, generation)

    // Cancel any in-progress render task for this document
    const existingTask = activeRenderTasks.get(doc)
    if (existingTask) {
        existingTask.cancel()
        activeRenderTasks.delete(doc)
    }

    const scale = zoom * devicePixelRatio
    const perfStart = performance.now()
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--total-scale-factor', scale)
    doc.documentElement.style.setProperty('--user-unit', '1')
    doc.documentElement.style.setProperty('--scale-round-x', '1px')
    doc.documentElement.style.setProperty('--scale-round-y', '1px')
    const viewport = page.getViewport({ scale })

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    const renderTask = page.render({ canvasContext, viewport, background: 'rgba(0,0,0,0)' })
    activeRenderTasks.set(doc, renderTask)

    try {
        await renderTask.promise
    } catch {
        // Render was cancelled or failed — release canvas bitmap memory
        canvas.width = 0
        canvas.height = 0
        return
    } finally {
        if (activeRenderTasks.get(doc) === renderTask) {
            activeRenderTasks.delete(doc)
        }
    }

    // Bail out if a newer render has started or iframe was removed
    if (renderGenerations.get(doc) !== generation || !doc.defaultView) {
        canvas.width = 0
        canvas.height = 0
        return
    }

    const canvasElement = doc.querySelector('#canvas')
    if (!canvasElement) {
        canvas.width = 0
        canvas.height = 0
        return
    }

    // Release old canvas bitmap memory before replacing
    const oldCanvas = canvasElement.querySelector('canvas')
    if (oldCanvas) {
        oldCanvas.width = 0
        oldCanvas.height = 0
    }
    canvasElement.replaceChildren(doc.adoptNode(canvas))

    // Clear text layer before re-rendering to prevent DOM accumulation
    const container = doc.querySelector('.textLayer')
    container.replaceChildren()
    const textLayer = new pdfjsLib.TextLayer({
        textContentSource: await page.streamTextContent(),
        container, viewport,
    })
    await textLayer.render()

    // Bail out if superseded after async text layer render
    if (renderGenerations.get(doc) !== generation) return

    // A PDF stores text in the producer's order, not the reader's: marginal
    // notes are interleaved with the body and glyphs jump around formulas.
    // Selection follows the DOM, so it is re-ordered to follow the eye.  A
    // layout heuristic must never cost the page itself, hence the guard.
    try {
        applyReadingOrder(container)
    } catch (e) {
        console.error('pdf: reading order failed', e)
    }

    globalThis.__perfMark?.('pdf:render', {
        page: page.pageNumber, scale: Math.round(scale * 100) / 100,
        dur: Math.round(performance.now() - perfStart),
    })

    // hide "offscreen" canvases appended to document when rendering text layer
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
    for (const hiddenCanvas of document.querySelectorAll('.hiddenCanvasElement'))
        Object.assign(hiddenCanvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            display: 'none',
        })

    // fix text selection
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
    const endOfContent = document.createElement('div')
    endOfContent.className = 'endOfContent'
    container.append(endOfContent)

    // Set up panning/selection event handlers once per document
    setupPanningEvents(doc)

    // The page's own geometry now decides what a drag selects, not the
    // browser's hit-testing.
    try {
        doc._marginaliaSelection = installGeometrySelection(doc, container)
    } catch (e) {
        console.error('pdf: geometry selection unavailable', e)
    }

    // Clear annotation layer before re-rendering to prevent DOM accumulation
    const div = doc.querySelector('.annotationLayer')
    div.replaceChildren()
    const linkService = {
        goToDestination: () => {},
        getDestinationHash: dest => JSON.stringify(dest),
        addLinkAttributes: (link, url) => link.href = url,
    }
    await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService }).render({
        annotations: await page.getAnnotations(),
    })
}

const renderPage = async (page, getImageBlob) => {
    const viewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        const canvasContext = canvas.getContext('2d')
        await page.render({ canvasContext, viewport }).promise
        return new Promise(resolve => canvas.toBlob(blob => {
            // Release canvas bitmap memory after extracting the blob
            canvas.width = 0
            canvas.height = 0
            resolve(blob)
        }))
    }
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.css
    if (textLayerBuilderCSS == null) {
        textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))
    }
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/annotation_layer_builder.css
    if (annotationLayerBuilderCSS == null) {
        annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))
    }
    const data = `
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        /* pdf.js asks for a text cursor on every word; one plain pointer over
           the whole page is what the reader wants to see. */
        .textLayer, .textLayer :is(span, br) { cursor: default; }
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `
    const src = URL.createObjectURL(new Blob([data], { type: 'text/html' }))
    const onZoom = ({ doc, scale }) => render(page, doc, scale)
    globalThis.__perfMark?.('pdf:page-html', { page: page.pageNumber })
    return { src, data, onZoom }
}

const makeTOCItem = async (item, pdf, indexByHref) => {
    let pageIndex = undefined

    if (item.dest) {
        try {
            const dest = typeof item.dest === 'string'
                ? await pdf.getDestination(item.dest)
                : item.dest
            if (dest?.[0]) {
                pageIndex = await pdf.getPageIndex(dest[0])
            }
        } catch (e) {
            console.warn('Failed to get page index for TOC item:', item.title, e)
        }
    }

    const href = item.dest ? JSON.stringify(item.dest) : ''
    // Remember the resolved page so that TOCProgress/resolveHref do not have to
    // round-trip to the worker a second time for every TOC entry.
    if (href && pageIndex != null && indexByHref) indexByHref.set(href, pageIndex)

    return {
        label: item.title,
        href,
        index: pageIndex,
        subitems: item.items?.length
            ? await Promise.all(item.items.map(i => makeTOCItem(i, pdf, indexByHref)))
            : null,
    }
}

const MAX_CACHED_PAGES = 8

export const makePDF = async file => {
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const pdf = await pdfjsLib.getDocument({
        range: transport,
        wasmUrl: pdfjsPath(''),
        cMapUrl: pdfjsPath('cmaps/'),
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    }).promise

    // Get viewport dimensions from first page for fixed-layout rendering
    const firstPage = await pdf.getPage(1)
    const firstViewport = firstPage.getViewport({ scale: 1 })
    const book = { rendition: {
        layout: 'pre-paginated',
        viewport: { width: firstViewport.width, height: firstViewport.height },
    } }

    const { metadata, info } = await pdf.getMetadata() ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const outline = await pdf.getOutline()
    const tocIndexByHref = new Map()
    book.toc = outline
        ? await Promise.all(outline.map(item => makeTOCItem(item, pdf, tocIndexByHref)))
        : null

    const cache = new Map()
    const pageCache = new Map()
    const getPage = async (i) => {
        const cached = pageCache.get(i)
        if (cached) {
            // Move to end for LRU ordering
            pageCache.delete(i)
            pageCache.set(i, cached)
            return cached
        }
        const page = await pdf.getPage(i + 1)
        pageCache.set(i, page)

        // Evict oldest pages when over limit, freeing internal page data
        while (pageCache.size > MAX_CACHED_PAGES) {
            const oldestKey = pageCache.keys().next().value
            const oldPage = pageCache.get(oldestKey)
            pageCache.delete(oldestKey)
            oldPage?.cleanup()
        }

        return page
    }
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const cached = cache.get(i)
            if (cached) {
                // Move to end for LRU ordering
                cache.delete(i)
                cache.set(i, cached)
                return cached
            }
            const url = await renderPage(await getPage(i))
            cache.set(i, url)

            // Evict oldest render results when over limit
            while (cache.size > MAX_CACHED_PAGES) {
                const oldestKey = cache.keys().next().value
                const oldEntry = cache.get(oldestKey)
                cache.delete(oldestKey)
                if (oldEntry?.src) URL.revokeObjectURL(oldEntry.src)
            }

            return url
        },
        createDocument: async () => {
            const page = await getPage(i)
            const doc = document.implementation.createHTMLDocument('')
            const perfStart = performance.now()

            const canvas = doc.createElement('div')
            canvas.id = 'canvas'
            doc.body.appendChild(canvas)

            const textLayer = doc.createElement('div')
            textLayer.className = 'textLayer'
            doc.body.appendChild(textLayer)

            // Built straight from the text items rather than from pdf.js's
            // TextLayer: the geometry is exact, no canvas font metrics are
            // needed (they cost seconds over a window of pages), and the text
            // comes out in reading order, one block per visual line, with the
            // spaces a producer only expresses as gaps between words.
            const viewport = page.getViewport({ scale: 1 })
            const items = (await readTextItems(page))
                .filter(item => typeof item.str === 'string')
                .map(item => ({
                    x: item.transform[4],
                    y: viewport.height - item.transform[5],
                    w: item.width,
                    h: item.height,
                    // An axis label set on its side: a sure sign of a graphic.
                    rot: Math.round(
                        Math.atan2(item.transform[1], item.transform[0]) * 180 / Math.PI),
                    str: item.str,
                }))
            let ordered = null
            try {
                ordered = orderItems(items, viewport.width)
            } catch (e) {
                console.error('pdf: reading order failed on page', page.pageNumber, e)
            }

            if (ordered) {
                const { lines, textHeight } = ordered
                const body = doc.createElement('div')
                body.className = 'pdfPage'
                for (const line of lines) {
                    if (line.zone !== 'body') continue
                    const text = lineToText(line, textHeight)
                    if (!text) continue
                    if (body.firstChild) body.appendChild(doc.createElement('br'))
                    body.appendChild(doc.createTextNode(text))
                }
                if (body.firstChild) textLayer.appendChild(body)
                // What is not text to read follows, tagged: the lettering of
                // the graphics, then the marginal notes.
                for (const zone of ['figure', 'margin']) {
                    for (const note of groupMarginNotes(lines, textHeight, zone)) {
                        const text = note.lines.map(line => lineToText(line, textHeight))
                            .filter(Boolean).join(' ').trim()
                        if (!text) continue
                        const div = doc.createElement('div')
                        div.className = zone === 'margin' ? 'pdfMarginNote' : 'pdfFigureText'
                        div.dataset.zone = zone
                        div.textContent = text
                        textLayer.appendChild(div)
                    }
                }
            } else {
                for (const item of items) {
                    if (!item.str) continue
                    const span = doc.createElement('span')
                    span.textContent = item.str
                    textLayer.appendChild(span)
                }
            }

            const annotationLayer = doc.createElement('div')
            annotationLayer.className = 'annotationLayer'
            doc.body.appendChild(annotationLayer)

            globalThis.__perfMark?.('pdf:create-doc', {
                page: page.pageNumber, dur: Math.round(performance.now() - perfStart),
            })
            return doc
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        if (tocIndexByHref.has(href)) return { index: tocIndexByHref.get(href) }
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return { index }
    }
    book.splitTOCHref = async href => {
        if (!href) return [null, null]
        if (tocIndexByHref.has(href)) return [tocIndexByHref.get(href), null]
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        try {
            const index = await pdf.getPageIndex(dest[0])
            return [index, null]
        } catch (e) {
            console.warn('Error getting page index for href', href, e)
            return [null, null]
        }
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    book.destroy = () => {
        // Clean up all cached canvases and revoke blob URLs
        for (const [, entry] of cache) {
            if (entry?.src) URL.revokeObjectURL(entry.src)
        }
        cache.clear()
        for (const [, page] of pageCache) {
            page?.cleanup()
        }
        pageCache.clear()
        pdf.destroy()
    }
    return book
}
