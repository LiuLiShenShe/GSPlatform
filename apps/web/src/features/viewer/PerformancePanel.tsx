/**
 * Performance panel showing live streaming metrics.
 *
 * Displays FPS, frame time, network throughput, cache hit ratio,
 * GPU resident chunks, and in-flight requests. Designed for the
 * dev toolbar (Phase 04 checklist G).
 *
 * The component is intentionally stateless: the host hook polls the
 * streaming scheduler and passes fresh snapshots down as props.
 */

import type { StreamingMetricsSnapshot } from '@gsplatform/viewer';

interface PerformancePanelProps {
  /** Latest metrics snapshot from the streaming scheduler. */
  metrics: StreamingMetricsSnapshot | null;
  /** Whether the streaming pipeline is active. */
  active: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatThroughput(bytesPerSec: number): string {
  if (bytesPerSec === 0) return '—';
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, lineHeight: '18px' }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span style={{ fontFamily: 'monospace' }}>{value}</span>
    </div>
  );
}

export function PerformancePanel({ metrics: s, active }: PerformancePanelProps) {
  return (
    <div
      className="performance-panel"
      style={{
        padding: '8px 12px',
        background: 'rgba(0,0,0,0.7)',
        borderRadius: 6,
        color: '#fff',
        fontSize: 12,
        minWidth: 200,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, opacity: 0.8, fontSize: 11, textTransform: 'uppercase' }}>
        Performance {active ? '●' : '○'}
      </div>

      {s ? (
        <>
          <MetricRow label="Network" value={formatThroughput(s.throughput)} />
          <MetricRow label="Fetched" value={`${s.chunksCompleted} chunks · ${formatBytes(s.bytesFetched)}`} />
          <MetricRow label="Failed" value={String(s.chunksFailed)} />
          <MetricRow label="Cancelled" value={String(s.chunksCancelled)} />
          <MetricRow label="Cache hit" value={`${(s.cacheHitRatio * 100).toFixed(0)}%`} />
          <MetricRow label="GPU resident" value={`${s.gpuResident} · ${formatBytes(s.gpuMemoryBytes)}`} />
        </>
      ) : (
        <div style={{ opacity: 0.4, fontSize: 11 }}>No metrics</div>
      )}
    </div>
  );
}