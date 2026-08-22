/**
 * `useUpdateCheck` — the advisory bundle-update state for the Channels panel.
 *
 * Owns the one GET /dsh-channels/api/v2/update-check the panel issues, so the
 * section itself stays a pure mount point:
 *   - fetched once per mount (the notice is advisory; the host caches its npm
 *     registry check and stamps `checkedAt`)
 *   - strictly non-fatal: any failure (network, non-2xx, bad JSON) degrades to
 *     `null` — no error state, no toast; an unreachable check must never break
 *     or disturb the Channels panel
 *   - the in-flight request is aborted on unmount so no stale answer lands
 *   - the browser never contacts npm itself — the host performs the check and
 *     serves the sanitized, secret-free projection (red line: no direct npm
 *     registry access from the client)
 *
 * Returns the full status (not just `update`): the panel-bottom repository
 * footer labels itself with `currentVersion` from the same projection.
 */
import { useEffect, useState } from 'react';
import { fetchUpdateCheck, type BundleUpdateStatus } from './api.js';

/** The update-check projection, or `null` while pending / failed. */
export function useUpdateCheck(): BundleUpdateStatus | null {
  const [status, setStatus] = useState<BundleUpdateStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchUpdateCheck(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setStatus(result);
      })
      .catch(() => {
        // Silent degradation by contract — see header.
      });
    return () => controller.abort();
  }, []);

  return status;
}
