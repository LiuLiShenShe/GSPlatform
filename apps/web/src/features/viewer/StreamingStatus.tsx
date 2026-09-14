/**
 * Streaming status indicator for the viewer toolbar.
 *
 * Shows the streamed-SOG load state: interactive-ready (low LOD first frame),
 * initial-view-ready (initial camera target reached), background-refining
 * (new targets loading after camera moves), or error. Phase 04 distinguishes
 * "initial ready" from "background refinement" so progress never regresses.
 */

import type { ResidencyStatus, ChunkKey } from '@gsplatform/viewer';

export type StreamingPhase =
  | 'loading-manifest'
  | 'interactive-ready'
  | 'initial-view-ready'
  | 'background-refining'
  | 'error';

export interface StreamingStatusProps {
  phase: StreamingPhase;
  /** Overall progress ratio 0–1 (target-set completed). */
  progress: number;
  /** Currently-resident chunk count. */
  residentChunks: number;
  /** Total chunk count in the current target set. */
  targetChunks: number;
  /** Quality mode label for display. */
  qualityLabel?: string;
  /** Error message when phase === 'error'. */
  errorMessage?: string;
}

const PHASE_LABEL: Record<StreamingPhase, string> = {
  'loading-manifest': '加载清单…',
  'interactive-ready': '低清可用',
  'initial-view-ready': '初始视图就绪',
  'background-refining': '后台细化',
  error: '加载失败',
};

export function StreamingStatus({
  phase,
  progress,
  residentChunks,
  targetChunks,
  qualityLabel,
  errorMessage,
}: StreamingStatusProps) {
  const pct = Math.round(progress * 100);
  const isError = phase === 'error';
  const isReady = phase === 'initial-view-ready' || phase === 'background-refining';

  return (
    <div
      className="streaming-status"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        color: isError ? '#ff6b6b' : isReady ? '#7bd88f' : '#bbb',
        fontFamily: 'system-ui, sans-serif',
        whiteSpace: 'nowrap',
      }}
      title={errorMessage}
    >
      <span
        className="streaming-status__dot"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: isError ? '#ff6b6b' : isReady ? '#7bd88f' : '#f0c060',
          display: 'inline-block',
        }}
      />
      <span>{PHASE_LABEL[phase]}</span>
      {qualityLabel && <span style={{ opacity: 0.6 }}>· {qualityLabel}</span>}
      {!isError && (
        <span style={{ opacity: 0.75, fontFamily: 'monospace' }}>
          {pct}% · {residentChunks}/{targetChunks}
        </span>
      )}
    </div>
  );
}

// re-export types so callers can build the props from a scheduler
export type { ChunkKey, ResidencyStatus };
