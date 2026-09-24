'use client';

/**
 * Pick the display formulas of a PDF page with one click, and ask about them.
 *
 * Detection is the reading engine's (packages/foliate-js/pdf-formulas.js),
 * run at idle once a page is on screen. This component puts a picking layer
 * on each loaded page, keeps the picks in the formula store, shows the action
 * bar near the last pick, and turns picks into chat selections carrying an
 * image of each formula: the model reads the image, the extracted text only
 * backs it up.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useChatStore } from '@/store/chatStore';
import { pickKey, useFormulaStore, type FormulaPick, type FormulaZone } from '@/store/formulaStore';
import useShortcuts from '@/hooks/useShortcuts';
import { useFoliateEvents } from '../../hooks/useFoliateEvents';
import { FormulaOverlay, circled } from '../../utils/formulaOverlay';

interface PdfFormulasDoc extends Document {
  __pdfFormulas?: { page: number; zones: FormulaZone[] };
}

type RenderRegion = (index: number, rect: FormulaZone, scale?: number) => Promise<string>;

const FormulaPicker: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const { getView, getProgress } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const view = getView(bookKey);
  const isPdf = getBookData(bookKey)?.book?.format === 'PDF';

  const picks = useFormulaStore((s) => s.picks);
  const showAll = useFormulaStore((s) => s.showAll);
  const zoneArmed = useFormulaStore((s) => s.zoneArmed);
  const mine = picks.filter((p) => p.bookKey === bookKey);

  const overlays = useRef(new Map<Document, FormulaOverlay>());
  const [busy, setBusy] = useState(false);

  /** Push the store's state to every page layer of this book. */
  const sync = useCallback(() => {
    const { picks, showAll, zoneArmed } = useFormulaStore.getState();
    for (const [doc, overlay] of overlays.current) {
      if (!overlay.alive) {
        overlays.current.delete(doc);
        continue;
      }
      const zones = (doc as PdfFormulasDoc).__pdfFormulas?.zones ?? [];
      const picked = new Map<number, number>();
      const free: { zone: FormulaZone; n: number }[] = [];
      picks
        .filter((p) => p.bookKey === bookKey)
        .forEach((p, order) => {
          if (p.index !== overlay.index) return;
          if (p.free) {
            free.push({ zone: p.zone, n: order + 1 });
            return;
          }
          const i = zones.findIndex((z) => pickKey(p.index, z) === p.key);
          if (i >= 0) picked.set(i, order + 1);
        });
      overlay.update({ picked, free, showAll, armed: zoneArmed });
    }
  }, [bookKey]);

  useEffect(() => {
    sync();
  }, [picks, showAll, zoneArmed, sync]);

  const attach = useCallback(
    (doc: PdfFormulasDoc, index: number) => {
      if (overlays.current.has(doc) || !doc.body) return;
      const store = useFormulaStore.getState;
      const overlay = new FormulaOverlay(doc, index, {
        onToggle: (zone) =>
          store().togglePick({ key: pickKey(index, zone), bookKey, index, zone, free: false }),
        onRemoveFree: (zone) =>
          store().keepPicks((p) => !(p.free && p.index === index && p.zone === zone)),
        onDraw: (zone) => {
          store().addPick({
            key: `free:${index}:${Date.now()}`,
            bookKey,
            index,
            zone,
            free: true,
          });
          store().setZoneArmed(false);
        },
      });
      overlays.current.set(doc, overlay);
      const apply = (zones: FormulaZone[]) => {
        overlay.setZones(zones);
        sync();
      };
      if (doc.__pdfFormulas) apply(doc.__pdfFormulas.zones);
      overlay.listen(apply);
      sync();
    },
    [bookKey, sync],
  );

  const isPdfRef = useRef(isPdf);
  isPdfRef.current = isPdf;
  const attachRef = useRef(attach);
  attachRef.current = attach;

  const onLoad = (event: Event) => {
    if (!isPdfRef.current) return;
    const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail;
    attachRef.current(doc as PdfFormulasDoc, index);
  };

  // Picks belong to the page they were made on: turning it drops them.
  const onRelocate = () => {
    const contents = getView(bookKey)?.renderer.getContents() ?? [];
    const visible = new Set(contents.map((c) => c.index));
    useFormulaStore.getState().keepPicks((p) => p.bookKey !== bookKey || visible.has(p.index));
    for (const [doc, overlay] of overlays.current) {
      if (!overlay.alive) overlays.current.delete(doc);
    }
  };

  useFoliateEvents(view, { onLoad, onRelocate });

  // Pages loaded before this component mounted.
  useEffect(() => {
    if (!isPdf || !view) return;
    for (const { doc, index } of view.renderer.getContents() ?? []) {
      if (index !== undefined) attach(doc as PdfFormulasDoc, index);
    }
  }, [isPdf, view, attach]);

  useEffect(
    () => () => {
      for (const overlay of overlays.current.values()) overlay.destroy();
      overlays.current.clear();
    },
    [],
  );

  const send = async (ask: boolean) => {
    const list = useFormulaStore.getState().picks.filter((p) => p.bookKey === bookKey);
    if (!list.length || busy) return;
    setBusy(true);
    try {
      const renderRegion = (getView(bookKey)?.book as { renderRegion?: RenderRegion } | undefined)
        ?.renderRegion;
      const chapter = getProgress(bookKey)?.sectionLabel || '';
      const chat = useChatStore.getState();
      for (const pick of list) {
        let imageBase64: string | undefined;
        try {
          imageBase64 = renderRegion ? await renderRegion(pick.index, pick.zone, 3) : undefined;
        } catch (e) {
          console.error('formula: image render failed', e);
        }
        const what = pick.free ? 'zone' : pick.zone.label || 'formule';
        chat.addSelection({
          text: pick.zone.text || '[zone de la page : voir l’image]',
          location: [chapter, `p. ${pick.index + 1}`, what].filter(Boolean).join(' · '),
          ...(imageBase64 ? { imageBase64 } : {}),
        });
      }
      // Only what was sent: a formula picked while the images rendered stays.
      useFormulaStore.getState().keepPicks((p) => !list.includes(p));
      chat.setOpen(true);
      if (ask) chat.requestAsk('Explique ce passage.');
    } finally {
      setBusy(false);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  useShortcuts(
    {
      onExplainSelection: () => {
        if (!useFormulaStore.getState().picks.some((p) => p.bookKey === bookKey)) return false;
        void sendRef.current(true);
        return true;
      },
      onEscape: () => {
        const s = useFormulaStore.getState();
        if (s.zoneArmed) {
          s.setZoneArmed(false);
          return true;
        }
        if (s.picks.some((p) => p.bookKey === bookKey)) {
          s.keepPicks((p) => p.bookKey !== bookKey);
          return true;
        }
        return false;
      },
    },
    [bookKey],
  );

  if (!isPdf || !mine.length || zoneArmed) return null;

  const last = mine[mine.length - 1] as FormulaPick;
  const label =
    mine.length === 1
      ? last.free
        ? 'Zone'
        : last.zone.label || 'Formule'
      : `${mine.length} ${mine.every((p) => !p.free) ? 'formules' : 'éléments'}`;

  return (
    // Bottom centre of the reading area, not next to the pick: placed under a
    // formula it covered the one below, the very next to be picked.
    <div
      className='absolute bottom-12 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-gray-800 py-1.5 pr-1.5 pl-3 text-white shadow-lg select-none'
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className='mr-1 text-xs text-gray-300'>
        {mine.length > 1 ? mine.map((_, i) => circled(i + 1)).join(' ') + ' · ' : ''}
        {label}
      </span>
      <button
        className='rounded-md bg-blue-600 px-3 py-1 text-sm font-medium hover:bg-blue-500 disabled:opacity-60'
        disabled={busy}
        onClick={() => void send(true)}
        title='Envoyer au chat et demander une explication (Ctrl+E)'
      >
        Ask AI
      </button>
      <button
        className='rounded-md bg-gray-600 px-3 py-1 text-sm hover:bg-gray-500 disabled:opacity-60'
        disabled={busy}
        onClick={() => void send(false)}
        title='Joindre au chat sans envoyer'
      >
        Joindre
      </button>
      <button
        className='rounded-md px-2 py-1 text-sm text-gray-300 hover:bg-gray-700'
        onClick={() => useFormulaStore.getState().keepPicks((p) => p.bookKey !== bookKey)}
        aria-label='Tout désélectionner (Échap)'
        title='Tout désélectionner (Échap)'
      >
        ✕
      </button>
    </div>
  );
};

export default FormulaPicker;
