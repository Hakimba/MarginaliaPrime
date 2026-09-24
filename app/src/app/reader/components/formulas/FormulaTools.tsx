'use client';

import React from 'react';
import { LuSigma, LuSquareDashedMousePointer } from 'react-icons/lu';

import { useBookDataStore } from '@/store/bookDataStore';
import { useFormulaStore } from '@/store/formulaStore';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import Button from '@/components/Button';

/**
 * Header buttons of a PDF: show every detected formula of the page, and the
 * Zone tool for what detection missed (a rectangle drawn by hand).
 */
const FormulaTools: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const { getBookData } = useBookDataStore();
  const showAll = useFormulaStore((s) => s.showAll);
  const zoneArmed = useFormulaStore((s) => s.zoneArmed);
  const iconSize16 = useResponsiveSize(16);

  if (getBookData(bookKey)?.book?.format !== 'PDF') return null;

  return (
    <>
      <Button
        icon={<LuSigma size={iconSize16} className={showAll ? 'text-primary' : 'text-base-content'} />}
        onClick={() => useFormulaStore.getState().setShowAll(!showAll)}
        label={showAll ? 'Masquer les formules' : 'Afficher les formules de la page'}
      />
      <Button
        icon={
          <LuSquareDashedMousePointer
            size={iconSize16}
            className={zoneArmed ? 'text-primary' : 'text-base-content'}
          />
        }
        onClick={() => useFormulaStore.getState().setZoneArmed(!zoneArmed)}
        label={zoneArmed ? 'Annuler la zone (Échap)' : 'Tracer une zone sur la page'}
      />
    </>
  );
};

export default FormulaTools;
