/**
 * The layer drawn over a PDF page to pick its formulas: a dashed outline and a
 * chip in the left margin when the pointer is over a formula, a solid outline
 * and its number (①, ②…) once picked, and the rectangle of the Zone tool.
 *
 * It lives inside the page's iframe, above the text layer, and costs the page
 * nothing it did not already do:
 *
 *   * positions are CSS expressions of the page's own scale variable
 *     (`--total-scale-factor`), so a zoom or a resize needs no recomputation;
 *   * the layer takes no pointer event except on its chips, so a drag still
 *     selects text and a click still turns the page, formula or not;
 *   * a chip stops the events it receives, so picking a formula neither turns
 *     the page nor starts a selection.
 *
 * Zones are in PDF points; the iframe's document is scaled by 1 / dpr, so a
 * length meant in screen pixels is multiplied by dpr.
 */
import type { FormulaZone } from '@/store/formulaStore';

const BLUE = '#1d5fd1';
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

export const circled = (n: number): string => CIRCLED[n - 1] ?? `(${n})`;

/** What the layer shows, recomputed by the owner from the store. */
export interface OverlayState {
  /** Order number of each picked detected zone, by zone index. */
  picked: Map<number, number>;
  /** Drawn rectangles picked on this page, with their order number. */
  free: { zone: FormulaZone; n: number }[];
  showAll: boolean;
  armed: boolean;
}

export interface OverlayCallbacks {
  onToggle: (zone: FormulaZone) => void;
  onRemoveFree: (zone: FormulaZone) => void;
  onDraw: (zone: FormulaZone) => void;
}

interface Drawn {
  outline: HTMLDivElement;
  chip: HTMLButtonElement;
}

export class FormulaOverlay {
  readonly doc: Document;
  readonly index: number;
  private layer: HTMLDivElement;
  private zones: FormulaZone[] = [];
  private drawn: Drawn[] = [];
  private freeDrawn: Drawn[] = [];
  private hovered = -1;
  private state: OverlayState = { picked: new Map(), free: [], showAll: false, armed: false };
  private capture: HTMLDivElement | null = null;
  private dpr: number;

  constructor(
    doc: Document,
    index: number,
    private callbacks: OverlayCallbacks,
  ) {
    this.doc = doc;
    this.index = index;
    this.dpr = doc.defaultView?.devicePixelRatio || 1;
    this.layer = doc.createElement('div');
    this.layer.className = 'formulaLayer';
    Object.assign(this.layer.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '10',
    });
    doc.body.appendChild(this.layer);
    doc.addEventListener('mousemove', this.onMove, { passive: true });
    // WebKit fires mouseleave on elements, not on the document.
    doc.documentElement.addEventListener('mouseleave', this.onLeave, { passive: true });
  }

  /** Detected zones, now and whenever the page is detected again. */
  listen(apply: (zones: FormulaZone[]) => void): void {
    this.onZones = (event: Event) => apply((event as CustomEvent<{ zones: FormulaZone[] }>).detail.zones);
    this.doc.addEventListener('pdf-formulas', this.onZones);
  }

  private onZones: ((event: Event) => void) | null = null;

  get alive(): boolean {
    return !!this.doc.defaultView && this.layer.isConnected;
  }

  /** Screen pixels per PDF point. */
  zoom(): number {
    const scale = parseFloat(
      this.doc.documentElement.style.getPropertyValue('--total-scale-factor') || '0',
    );
    return scale > 0 ? scale / this.dpr : 0;
  }

  setZones(zones: FormulaZone[]): void {
    this.zones = zones;
    for (const d of this.drawn) {
      d.outline.remove();
      d.chip.remove();
    }
    this.drawn = zones.map((zone) => {
      const outline = this.makeOutline(zone);
      const chip = this.makeChip(zone, () => this.callbacks.onToggle(zone));
      return { outline, chip };
    });
    this.hovered = -1;
    this.paint();
  }

  update(state: OverlayState): void {
    const armedChanged = state.armed !== this.state.armed;
    this.state = state;
    for (const d of this.freeDrawn) {
      d.outline.remove();
      d.chip.remove();
    }
    this.freeDrawn = state.free.map(({ zone }) => ({
      outline: this.makeOutline(zone),
      chip: this.makeChip(zone, () => this.callbacks.onRemoveFree(zone)),
    }));
    if (armedChanged) this.setArmed(state.armed);
    this.paint();
  }

  destroy(): void {
    this.doc.removeEventListener('mousemove', this.onMove);
    this.doc.documentElement.removeEventListener('mouseleave', this.onLeave);
    if (this.onZones) this.doc.removeEventListener('pdf-formulas', this.onZones);
    this.setArmed(false);
    this.layer.remove();
  }

  private px(points: number, screenOffset = 0): string {
    const offset = screenOffset * this.dpr;
    return offset
      ? `calc(var(--total-scale-factor) * ${points}px + ${offset}px)`
      : `calc(var(--total-scale-factor) * ${points}px)`;
  }

  private makeOutline(zone: FormulaZone): HTMLDivElement {
    const outline = this.doc.createElement('div');
    Object.assign(outline.style, {
      position: 'absolute',
      left: this.px(zone.x),
      top: this.px(zone.y),
      width: this.px(zone.w),
      height: this.px(zone.h),
      borderRadius: `${4 * this.dpr}px`,
      boxSizing: 'border-box',
      pointerEvents: 'none',
      display: 'none',
    });
    this.layer.appendChild(outline);
    return outline;
  }

  private makeChip(zone: FormulaZone, onPick: () => void): HTMLButtonElement {
    const d = this.dpr;
    const chip = this.doc.createElement('button');
    chip.type = 'button';
    Object.assign(chip.style, {
      position: 'absolute',
      left: `max(${2 * d}px, ${this.px(zone.x, -30)})`,
      top: this.px(zone.y + zone.h / 2, -11),
      minWidth: `${22 * d}px`,
      height: `${22 * d}px`,
      padding: `0 ${5 * d}px`,
      borderRadius: `${11 * d}px`,
      border: `${1.5 * d}px solid ${BLUE}`,
      font: `700 ${12 * d}px system-ui, sans-serif`,
      lineHeight: '1',
      cursor: 'pointer',
      pointerEvents: 'auto',
      boxShadow: `0 ${d}px ${4 * d}px rgba(31,30,27,0.2)`,
      display: 'none',
    });
    // The page listens on its document, in the bubbling phase: stopping the
    // events here keeps a pick from turning the page or starting a selection.
    // Only the default of `mousedown` is cancelled (it would collapse a text
    // selection); cancelling `pointerdown` would suppress the click itself.
    const stop = (event: Event) => event.stopPropagation();
    for (const type of ['pointerdown', 'pointerup', 'mouseup', 'dblclick', 'touchstart', 'touchend']) {
      chip.addEventListener(type, stop);
    }
    chip.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onPick();
    });
    this.layer.appendChild(chip);
    return chip;
  }

  private paint(): void {
    const { picked, showAll, armed, free } = this.state;
    this.zones.forEach((zone, i) => {
      const d = this.drawn[i];
      if (!d) return;
      const n = picked.get(i);
      const hovered = i === this.hovered;
      const visible = !armed && (n !== undefined || hovered || showAll);
      this.style(d, visible, n, hovered, zone.label);
    });
    free.forEach(({ n }, i) => {
      const d = this.freeDrawn[i];
      if (d) this.style(d, true, n, false, 'Zone');
    });
  }

  private style(d: Drawn, visible: boolean, n: number | undefined, hovered: boolean, label: string) {
    const px = this.dpr;
    d.outline.style.display = visible ? 'block' : 'none';
    d.chip.style.display = visible ? 'flex' : 'none';
    if (!visible) return;
    const picked = n !== undefined;
    d.outline.style.border = picked
      ? `${2 * px}px solid ${BLUE}`
      : `${1.5 * px}px dashed ${hovered ? BLUE : '#8fb0e6'}`;
    d.outline.style.background = picked
      ? 'rgba(29,95,209,0.10)'
      : hovered
        ? 'rgba(29,95,209,0.05)'
        : 'transparent';
    d.chip.style.alignItems = 'center';
    d.chip.style.justifyContent = 'center';
    d.chip.style.background = picked ? BLUE : '#ffffff';
    d.chip.style.color = picked ? '#ffffff' : BLUE;
    d.chip.textContent = picked ? circled(n) : '+';
    const what = label ? `la formule ${label}` : 'cette formule';
    d.chip.title = picked ? `Retirer ${what}` : `Choisir ${what}`;
    d.chip.setAttribute('aria-label', d.chip.title);
    d.chip.setAttribute('aria-pressed', picked ? 'true' : 'false');
  }

  private onMove = (event: MouseEvent) => {
    if (this.state.armed || !this.zones.length) return;
    const k = this.zoom();
    if (!k) return;
    const x = event.clientX / k;
    const y = event.clientY / k;
    // The hover area reaches into the margin, where the chip is, so the
    // pointer can travel from the formula to its chip without losing it.
    const reach = 34 / k;
    // At least as tall as the chip, which is centred on the zone: on a
    // one-line display the chip overhangs it.
    const half = 14 / k;
    const i = this.zones.findIndex((z) => {
      const middle = z.y + z.h / 2;
      const top = Math.min(z.y, middle - half);
      const bottom = Math.max(z.y + z.h, middle + half);
      return x >= z.x - reach && x <= z.x + z.w && y >= top && y <= bottom;
    });
    if (i !== this.hovered) {
      this.hovered = i;
      this.paint();
    }
  };

  private onLeave = () => {
    if (this.hovered === -1) return;
    this.hovered = -1;
    this.paint();
  };

  /** The Zone tool: a sheet over the page that takes the drag, only while armed. */
  private setArmed(armed: boolean): void {
    if (!armed) {
      this.capture?.remove();
      this.capture = null;
      return;
    }
    if (this.capture) return;
    const sheet = this.doc.createElement('div');
    Object.assign(sheet.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      cursor: 'crosshair',
      pointerEvents: 'auto',
      zIndex: '11',
    });
    const box = this.doc.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      border: `${1.5 * this.dpr}px solid ${BLUE}`,
      background: 'rgba(29,95,209,0.10)',
      display: 'none',
      pointerEvents: 'none',
    });
    sheet.appendChild(box);
    let start: { x: number; y: number } | null = null;
    const pos = (event: PointerEvent) => {
      const k = this.zoom() || 1;
      return { x: event.clientX / k, y: event.clientY / k };
    };
    const place = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const k = this.zoom() || 1;
      Object.assign(box.style, {
        display: 'block',
        left: `${Math.min(a.x, b.x) * k * this.dpr}px`,
        top: `${Math.min(a.y, b.y) * k * this.dpr}px`,
        width: `${Math.abs(a.x - b.x) * k * this.dpr}px`,
        height: `${Math.abs(a.y - b.y) * k * this.dpr}px`,
      });
    };
    const stop = (event: Event) => event.stopPropagation();
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend']) {
      sheet.addEventListener(type, (event) => {
        event.preventDefault();
        stop(event);
      });
    }
    sheet.addEventListener('pointerdown', (event) => {
      stop(event);
      if (event.button !== 0) return;
      start = pos(event);
      sheet.setPointerCapture(event.pointerId);
    });
    sheet.addEventListener('pointermove', (event) => {
      stop(event);
      if (start) place(start, pos(event));
    });
    sheet.addEventListener('pointercancel', (event) => {
      stop(event);
      start = null;
      box.style.display = 'none';
    });
    sheet.addEventListener('pointerup', (event) => {
      stop(event);
      if (!start) return;
      const end = pos(event);
      const zone: FormulaZone = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        w: Math.abs(start.x - end.x),
        h: Math.abs(start.y - end.y),
        label: '',
        text: '',
      };
      start = null;
      box.style.display = 'none';
      // A click without a drag draws nothing.
      if (zone.w >= 6 && zone.h >= 6) this.callbacks.onDraw(zone);
    });
    this.layer.appendChild(sheet);
    this.capture = sheet;
  }
}
