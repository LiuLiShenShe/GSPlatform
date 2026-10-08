import { useEffect, useRef, useState } from 'react';
import { fetchUploadProcessingStatus, type UploadProcessingStatus } from './ResumableUploader';

/**
 * FIX-UPLOAD-01.1 §A2 — processing-poll lifecycle for the UploadPage.
 *
 * The status surface (GET /uploads/{id}/status) reports three segregated real
 * server states.  The poll must NOT stop just because the publish job reached
 * SUCCEEDED: the auto collision build is chained *after* publish commits, so
 * its job may still be null (dispatch pending), QUEUED or RUNNING.  Polling
 * continues until the collision job reaches a terminal state, or until the
 * upload/publish pipeline failed.
 */

export const PROCESSING_POLL_INTERVAL_MS = 3000;
export const PROCESSING_MAX_BACKOFF_MS = 30_000;
/** Reasonable observation cap: after this we stop auto-polling and ask the
 * user to re-query manually (we never fabricate a server terminal state). */
export const PROCESSING_OBSERVATION_LIMIT_MS = 5 * 60 * 1000;

/**
 * Terminal predicate (§A2 rules 1-8).
 *
 *  - upload FAILED                       → stop (upload failure UI)
 *  - upload still processing             → keep watching
 *  - publish FAILED                      → stop (publish failure UI)
 *  - publish not SUCCEEDED (incl. null)  → keep watching
 *  - publish SUCCEEDED + collision null  → keep watching (waiting for dispatch)
 *  - publish SUCCEEDED + collision QUEUED → keep watching
 *  - publish SUCCEEDED + collision RUNNING → keep watching
 *  - publish SUCCEEDED + collision SUCCEEDED/FAILED → stop (terminal)
 */
export function shouldStopProcessingPoll(st: UploadProcessingStatus): boolean {
  if (st.status === 'FAILED') return true;
  if (st.status !== 'SUCCEEDED') return false;
  if (st.publishStatus === 'FAILED') return true;
  if (st.publishStatus !== 'SUCCEEDED') return false;
  return st.collisionStatus === 'SUCCEEDED' || st.collisionStatus === 'FAILED';
}

export interface UploadProcessingPollState {
  uploadStatus: string;
  publishStatus: string | null;
  collisionStatus: string | null;
  publishJobId: string | null;
  sceneId: string | null;
  sceneSlug: string | null;
  /** Observation cap reached — the real server state could not be confirmed
   * within the limit; the UI must show "状态尚未确认" with a re-query entry. */
  unconfirmed: boolean;
  /** A poll loop is currently active. */
  polling: boolean;
}

export interface UploadProcessingPollResult extends UploadProcessingPollState {
  /** Restart observation (manual re-query after the cap / transient errors). */
  reQuery: () => void;
}

const INITIAL: UploadProcessingPollState = {
  uploadStatus: 'QUEUED',
  publishStatus: null,
  collisionStatus: null,
  publishJobId: null,
  sceneId: null,
  sceneSlug: null,
  unconfirmed: false,
  polling: false,
};

/**
 * Polls the read-only status surface for one upload id while ``enabled``.
 *
 * Lifecycle guarantees (§A4):
 *  - cleanup on unmount / uploadId change / disabled → no leaked loop;
 *  - the current uploadId is captured per loop, so a stale response for an
 *    older upload can never overwrite the new upload's state;
 *  - StrictMode double-effects: the cleanup of the first mount cancels it, so
 *    exactly one loop survives per (uploadId, enabled);
 *  - transient network errors: bounded exponential backoff, never a fabricated
 *    terminal status;
 *  - after the observation cap, auto-polling stops and ``unconfirmed`` is set
 *    (the server task is untouched — no FAILED is invented); ``reQuery()``
 *    restarts observation through the same read-only API.
 */
export function useUploadProcessingPoll(
  uploadId: string | null,
  enabled: boolean,
): UploadProcessingPollResult {
  const [state, setState] = useState<UploadProcessingPollState>(INITIAL);
  const [nonce, setNonce] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!uploadId || !enabled) return;

    let cancelled = false;
    let timer: number | undefined;
    let consecutiveErrors = 0;
    const startedAt = Date.now();
    const targetUploadId = uploadId;

    // The loop is live from the moment it starts (independent of whether the
    // first response is applicable) — an observation cap or a stale response
    // must not make the UI look idle while requests are in flight.
    setState((prev) => ({ ...prev, polling: true, unconfirmed: false }));

    const apply = (st: UploadProcessingStatus): void => {
      // Guard: an older upload's response must never overwrite the new one.
      if (st.uploadId !== targetUploadId) return;
      setState((prev) => ({
        ...prev,
        uploadStatus: st.status,
        publishStatus: st.publishStatus,
        collisionStatus: st.collisionStatus,
        publishJobId: st.publishJobId,
        sceneId: st.sceneId,
        sceneSlug: st.sceneSlug,
        unconfirmed: false,
        polling: true,
      }));
    };

    const schedule = (delay: number): void => {
      timer = window.setTimeout(() => void tick(), delay);
    };

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const st = await fetchUploadProcessingStatus(targetUploadId);
        if (cancelled) return;
        // Guard against a stale response for an older upload: it must neither
        // overwrite state nor drive a terminal decision for the current upload.
        if (st.uploadId !== targetUploadId) {
          schedule(PROCESSING_POLL_INTERVAL_MS);
          return;
        }
        consecutiveErrors = 0;
        apply(st);
        if (shouldStopProcessingPoll(st)) {
          setState((prev) => ({ ...prev, polling: false }));
          return;
        }
        if (Date.now() - startedAt > PROCESSING_OBSERVATION_LIMIT_MS) {
          // Honest cap: stop auto-polling, surface "状态尚未确认". We never
          // mark the real server-side job FAILED.
          setState((prev) => ({ ...prev, polling: false, unconfirmed: true }));
          return;
        }
        schedule(PROCESSING_POLL_INTERVAL_MS);
      } catch {
        if (cancelled) return;
        consecutiveErrors += 1;
        // Bounded exponential backoff: 3s → 6s → 12s → 24s → hard-capped at
        // PROCESSING_MAX_BACKOFF_MS.  The doubling is NOT capped first (else the
        // hard cap would never bind); the cap is the only bound.
        const backoff = Math.min(
          PROCESSING_POLL_INTERVAL_MS * 2 ** consecutiveErrors,
          PROCESSING_MAX_BACKOFF_MS,
        );
        schedule(backoff);
      }
    };

    schedule(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [uploadId, enabled, nonce]);

  const reQuery = (): void => {
    setState((prev) => ({ ...prev, unconfirmed: false, polling: true }));
    setNonce((n) => n + 1);
  };

  return { ...state, reQuery };
}
