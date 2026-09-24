import { create } from 'zustand';

/** A display formula of a PDF page, in PDF points (top-left origin). */
export interface FormulaZone {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Equation number such as "(6.100)", or '' when the display has none. */
  label: string;
  /** The formula's glyphs as extracted text, a fallback for the model. */
  text: string;
}

/** A formula the reader picked, or a rectangle they drew. */
export interface FormulaPick {
  key: string;
  bookKey: string;
  /** Section index, i.e. the page index for a PDF. */
  index: number;
  zone: FormulaZone;
  /** Drawn with the Zone tool rather than detected. */
  free: boolean;
}

interface FormulaState {
  /** In click order: the order is the numbering the reader sees, ① ② ③. */
  picks: FormulaPick[];
  /** Show every detected formula of the visible pages, not only the hovered one. */
  showAll: boolean;
  /** The Zone tool is armed: the next drag on a page draws a rectangle. */
  zoneArmed: boolean;

  togglePick: (pick: FormulaPick) => void;
  addPick: (pick: FormulaPick) => void;
  keepPicks: (keep: (pick: FormulaPick) => boolean) => void;
  setShowAll: (show: boolean) => void;
  setZoneArmed: (armed: boolean) => void;
}

export const pickKey = (index: number, zone: FormulaZone): string =>
  `${index}:${Math.round(zone.x)}:${Math.round(zone.y)}:${Math.round(zone.w)}:${Math.round(zone.h)}`;

export const useFormulaStore = create<FormulaState>()((set) => ({
  picks: [],
  showAll: false,
  zoneArmed: false,

  togglePick: (pick) =>
    set((s) =>
      s.picks.some((p) => p.key === pick.key)
        ? { picks: s.picks.filter((p) => p.key !== pick.key) }
        : { picks: [...s.picks, pick] },
    ),
  addPick: (pick) => set((s) => ({ picks: [...s.picks, pick] })),
  keepPicks: (keep) =>
    set((s) => {
      const picks = s.picks.filter(keep);
      return picks.length === s.picks.length ? s : { picks };
    }),
  setShowAll: (show) => set({ showAll: show }),
  setZoneArmed: (armed) => set({ zoneArmed: armed }),
}));
