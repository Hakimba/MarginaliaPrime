'use client';

import React, { useState } from 'react';
import { FiChevronDown, FiChevronRight, FiX } from 'react-icons/fi';

import type { EngineStartInfo, EngineUsage } from '@/services/engine';

export interface InspectData {
  /** What the backend was launched with, or null before the first send. */
  start: EngineStartInfo | null;
  /** CLI session id, once the backend reported it. */
  sessionId: string | null;
  /** The next message, exactly as it will be written to the engine. */
  nextMessage: string;
  /** Whether that message will carry the chapter text. */
  includesChapter: boolean;
  /** Number of images attached to the next message. */
  imageCount: number;
  /** Usage of the last completed turn. */
  lastUsage?: EngineUsage;
  lastCostUsd?: number;
  /** Raw lines received from the backend, newest last. */
  rawLines: string[];
}

const Section: React.FC<{
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, badge, defaultOpen = true, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className='border-base-300 overflow-hidden rounded-lg border'>
      <button
        className='bg-base-200/50 hover:bg-base-200 flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium transition-colors'
        onClick={() => setOpen(!open)}
      >
        {open ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
        {title}
        {badge && <span className='badge badge-sm badge-ghost ml-auto'>{badge}</span>}
      </button>
      {open && <div className='border-base-300 border-t p-3'>{children}</div>}
    </div>
  );
};

const Pre: React.FC<{ children: string }> = ({ children }) => (
  <pre className='bg-base-200/40 max-h-64 overflow-auto rounded p-2 text-xs whitespace-pre-wrap select-text'>
    {children}
  </pre>
);

/**
 * Shows exactly what goes to the engine and what comes back. The point is to
 * make the context auditable: if the model answers badly, the first question is
 * always "what did it actually receive?".
 */
const InspectOverlay: React.FC<{ data: InspectData; onClose: () => void }> = ({
  data,
  onClose,
}) => {
  const { start, sessionId, nextMessage, includesChapter, imageCount, lastUsage, lastCostUsd } =
    data;

  return (
    <div className='fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4'>
      <div className='bg-base-100 flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl shadow-xl'>
        <div className='border-base-300 flex items-center border-b px-4 py-3'>
          <h2 className='text-base font-semibold'>Contexte envoyé au moteur</h2>
          <div className='flex-1' />
          <button className='btn btn-ghost btn-sm btn-square' onClick={onClose} title='Fermer'>
            <FiX size={16} />
          </button>
        </div>

        <div className='flex flex-col gap-3 overflow-auto p-4'>
          <Section title='Processus' badge={start ? 'lancé' : 'pas encore lancé'}>
            {start ? (
              <div className='flex flex-col gap-2 text-xs'>
                <div>
                  <span className='opacity-60'>binaire </span>
                  <span className='select-text'>{start.binary}</span>
                </div>
                <div>
                  <span className='opacity-60'>dossier de travail </span>
                  <span className='select-text'>{start.cwd}</span>
                </div>
                <div>
                  <span className='opacity-60'>session </span>
                  <span className='select-text'>{sessionId ?? '—'}</span>
                </div>
                <Pre>{start.args.join(' ')}</Pre>
              </div>
            ) : (
              <p className='text-xs opacity-60'>
                Le moteur démarre au premier message de la conversation.
              </p>
            )}
          </Section>

          <Section title='Consignes permanentes' defaultOpen={false}>
            <Pre>{start?.harness ?? '—'}</Pre>
          </Section>

          <Section
            title='Prochain message'
            badge={[
              includesChapter ? 'chapitre inclus' : 'sans chapitre',
              imageCount > 0 ? `${imageCount} image${imageCount > 1 ? 's' : ''}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <Pre>{nextMessage || '(vide — sélectionne un passage ou écris une question)'}</Pre>
          </Section>

          <Section title='Dernier tour' defaultOpen={false}>
            {lastUsage ? (
              <div className='flex flex-col gap-1 text-xs'>
                <div>entrée : {lastUsage.inputTokens ?? 0} tokens</div>
                <div>sortie : {lastUsage.outputTokens ?? 0} tokens</div>
                <div>
                  cache lu : {lastUsage.cacheReadInputTokens ?? 0} · écrit :{' '}
                  {lastUsage.cacheCreationInputTokens ?? 0}
                </div>
                {typeof lastCostUsd === 'number' && (
                  <div className='opacity-60'>
                    équivalent API : {lastCostUsd.toFixed(4)} $ (facturé sur l&apos;abonnement)
                  </div>
                )}
              </div>
            ) : (
              <p className='text-xs opacity-60'>Aucun tour terminé.</p>
            )}
          </Section>

          <Section title='Flux brut du moteur' badge={String(data.rawLines.length)} defaultOpen={false}>
            <Pre>{data.rawLines.slice(-40).join('\n') || '—'}</Pre>
          </Section>
        </div>
      </div>
    </div>
  );
};

export default InspectOverlay;
