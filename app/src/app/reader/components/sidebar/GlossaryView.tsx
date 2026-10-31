import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import type { BookDoc } from '@/libs/document';
import { displayLatex, type GlossaryEntry } from '@/services/glossary';
import { renderChatMarkdown } from '@/services/chat/markdown';
import { useGlossaryStore } from '@/store/glossaryStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';

const GlossaryCard = React.memo(function GlossaryCard({ entry, fixed, count, navigate }: {
  entry: GlossaryEntry;
  fixed: boolean;
  count: number;
  navigate: (page: number) => Promise<void>;
}) {
  const explanation = useMemo(() => renderChatMarkdown(entry.explanation), [entry.explanation]);
  const latex = useMemo(
    () => (displayLatex(entry.latex) ? renderChatMarkdown(`$$\n${displayLatex(entry.latex)}\n$$`) : ''),
    [entry.latex],
  );
  return (
    <article data-glossary-term={entry.term} tabIndex={-1} className='border-base-300 rounded-lg border p-3 break-words focus:outline focus:outline-2 focus:outline-primary'>
      <h3 className='mb-1 font-semibold'>{entry.term}</h3>
      {latex && <div className='chat-markdown mb-2 overflow-x-auto' dangerouslySetInnerHTML={{ __html: latex }} />}
      <div className='chat-markdown prose prose-sm max-w-none' dangerouslySetInnerHTML={{ __html: explanation }} />
      <div className='mt-2 flex flex-wrap items-center justify-between gap-2 text-xs'>
        <button type='button' className='link link-primary' onClick={() => void navigate(entry.page)} disabled={entry.page > count}>{fixed ? `p. ${entry.page}` : `section ${entry.page}`}</button>
        <time dateTime={new Date(entry.date).toISOString()} className='opacity-60'>{new Date(entry.date).toLocaleDateString('fr-FR')}</time>
      </div>
    </article>
  );
});

const GlossaryView: React.FC<{ bookKey: string; bookDoc: BookDoc }> = ({ bookKey, bookDoc }) => {
  const hash = bookKey.split('-')[0] ?? '';
  const glossary = useGlossaryStore((s) => s.books[hash]);
  const focus = useGlossaryStore((s) => s.focusRequest);
  const root = useRef<HTMLDivElement>(null);
  const fixed = useBookDataStore((s) => s.getBookData(bookKey)?.isFixedLayout ?? true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [term, setTerm] = useState('');
  const [latex, setLatex] = useState('');
  const [explanation, setExplanation] = useState('');
  const [page, setPage] = useState('');
  const [error, setError] = useState('');
  const unit = fixed ? 'Page du PDF' : 'Section du livre';
  const count = bookDoc.sections?.length ?? 0;

  useEffect(() => {
    void useGlossaryStore.getState().reload(hash).catch(() => {});
  }, [hash]);

  useEffect(() => {
    if (focus?.hash !== hash) return;
    const item = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-glossary-term]') ?? [])
      .find((element) => element.dataset['glossaryTerm'] === focus.term);
    item?.scrollIntoView({ block: 'nearest' });
    item?.focus({ preventScroll: true });
    if (item) useGlossaryStore.getState().acknowledgeFocus(focus.seq);
  }, [focus, hash, glossary]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await useGlossaryStore.getState().add(hash, { term, latex, explanation, page: Number(page) });
      setEditing(false);
      setTerm('');
      setLatex('');
      setExplanation('');
      setPage('');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const navigate = useCallback(async (page: number) => {
    try {
      await useReaderStore.getState().getView(bookKey)?.goTo(page - 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [bookKey]);

  return (
    <div ref={root} className='flex flex-col gap-3 p-3' aria-label='Glossaire du livre'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h2 className='font-semibold'>Glossaire</h2>
        <button type='button' className='btn btn-ghost btn-sm' onClick={() => {
          setEditing(!editing);
          if (!page) setPage(String((useReaderStore.getState().getProgress(bookKey)?.section?.current ?? 0) + 1));
        }} aria-expanded={editing}>Ajouter un terme</button>
      </div>
      {glossary?.kind === 'error' && (
        <div role='alert' className='text-error text-sm'>
          <p>Le glossaire n’a pas pu être actualisé. {glossary.message}</p>
          <button type='button' className='btn btn-ghost btn-sm' onClick={() => void useGlossaryStore.getState().reload(hash).catch(() => {})}>Réessayer</button>
        </div>
      )}
      {error && <p role='alert' className='text-error text-sm'>{error}</p>}
      {editing && (
        <form onSubmit={(event) => void save(event)} className='flex flex-col gap-2'>
          <label className='flex flex-col gap-1'>Terme ou symbole
            <input className='input input-bordered input-sm w-full' value={term} onChange={(e) => setTerm(e.target.value)} maxLength={200} required />
          </label>
          <label className='flex flex-col gap-1'>LaTeX facultatif
            <input className='input input-bordered input-sm w-full font-mono' value={latex} onChange={(e) => setLatex(e.target.value)} maxLength={2000} />
          </label>
          <label className='flex flex-col gap-1'>Explication
            <textarea className='textarea textarea-bordered w-full' value={explanation} onChange={(e) => setExplanation(e.target.value)} maxLength={8000} rows={3} required />
          </label>
          <label className='flex flex-col gap-1'>{unit}
            <input className='input input-bordered input-sm w-full' type='number' min={1} max={count || undefined} step={1} value={page} onChange={(e) => setPage(e.target.value)} required />
          </label>
          <p className='text-xs opacity-60'>Le même terme à la même page met à jour son explication.</p>
          <button type='submit' className='btn btn-primary btn-sm' disabled={saving}>{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
        </form>
      )}
      {(!glossary || glossary.kind === 'loading') && <p role='status' className='text-sm opacity-60'>Chargement du glossaire…</p>}
      {glossary?.kind === 'ready' && !glossary.entries.length && <p className='text-sm opacity-60'>Aucun terme pour ce livre. Ajoute une entrée ou demande à Claude d’expliquer un terme.</p>}
      {glossary?.entries.map((entry) => (
        <GlossaryCard key={JSON.stringify([entry.term, entry.page])} entry={entry} fixed={fixed} count={count} navigate={navigate} />
      ))}
    </div>
  );
};

export default GlossaryView;
