import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listTelescopes } from '../lib/api/telescopes';
import { readFovSetup, resolveFov, type ResolvedFov } from '../lib/telescopeFov';

/**
 * The FOV currently in effect for framing previews, app-wide: the user's
 * saved Framing & Mosaic pick (localStorage — see `telescopeFov.ts`), falling
 * back to whichever telescope is configured under Settings → Telescopes when
 * nothing has been saved yet — including that telescope's own custom optics,
 * if it's an `other`/`asiair` kind with them set.
 *
 * Read once per mount rather than subscribed live: the Framing modal is the
 * only place that changes the saved setup, and it lives on a different page
 * (object/observation detail) than the consumers that need this hook (the
 * Planner list), so there's no same-view live-sync requirement to justify a
 * context.
 */
export function useResolvedFov(): ResolvedFov {
  const { data: telescopes } = useQuery({ queryKey: ['telescopes'], queryFn: listTelescopes, staleTime: 60_000 });
  const [setup] = useState(readFovSetup);
  return useMemo(() => resolveFov(setup, telescopes), [setup, telescopes]);
}
