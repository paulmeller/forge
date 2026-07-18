'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Portals its children into the shared app-shell header's #page-header-slot
 * (see (app)/layout.tsx), so a page can put its own navigation (e.g. a tab
 * bar) inline with the sidebar trigger instead of taking its own row in the
 * page's content area.
 */
export function HeaderPortal({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById('page-header-slot'));
  }, []);

  if (!slot) return null;
  return createPortal(children, slot);
}
