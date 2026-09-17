import { httpClient } from '../../services/http';

/**
 * ResumableUploader — real resumable chunked upload against the Phase 06 API.
 *
 * Protocol:
 *   POST   /uploads               → create session (returns uploadId, chunkMaxBytes)
 *   HEAD   /uploads/{id}          → query server offset (resume after refresh)
 *   PATCH  /uploads/{id}          → write one chunk (Upload-Offset header)
 *   POST   /uploads/{id}/complete → finalize; server enqueues publish job
 *   DELETE /uploads/{id}          → cancel & clean up
 *
 * The uploader tracks real bytes sent, not fake percentages. Pausing aborts the
 * in-flight chunk; resuming re-queries the server offset and continues from it.
 */

export interface UploadSessionInfo {
  uploadId: string;
  status: string;
  offset: number;
  totalSize: number;
  chunkMaxBytes: number;
}

export interface CompleteResult {
  uploadId: string;
  status: string;
  jobId: string | null;
}

export type UploadEvent =
  | { type: 'progress'; sent: number; total: number; speed: number }
  | { type: 'paused'; sent: number; total: number }
  | { type: 'resumed'; offset: number; total: number }
  | { type: 'completed'; result: CompleteResult }
  | { type: 'error'; message: string; code: string };

export class UploadCancelledError extends Error {
  constructor() {
    super('upload cancelled');
    this.name = 'UploadCancelledError';
  }
}

export class ResumableUploader {
  private readonly file: File;
  private readonly session: UploadSessionInfo;
  private chunkMaxBytes: number;
  private readonly onEvent: (e: UploadEvent) => void;
  private cancelled = false;
  private paused = false;
  private activeController: AbortController | null = null;
  private sentBytes = 0;
  private startedAt = 0;

  constructor(
    file: File,
    session: UploadSessionInfo,
    onEvent: (e: UploadEvent) => void,
  ) {
    this.file = file;
    this.session = session;
    this.chunkMaxBytes = session.chunkMaxBytes || 8 * 1024 * 1024;
    this.onEvent = onEvent;
  }

  async run(): Promise<void> {
    this.startedAt = Date.now();
    let offset = this.session.offset;

    // Resume path: re-query server offset so a page refresh can continue.
    if (offset > 0) {
      offset = await this.queryServerOffset();
      this.onEvent({ type: 'resumed', offset, total: this.file.size });
    }

    while (offset < this.file.size) {
      if (this.cancelled) {
        throw new UploadCancelledError();
      }
      while (this.paused) {
        await this.delay(150);
        if (this.cancelled) {
          throw new UploadCancelledError();
        }
      }

      const end = Math.min(offset + this.chunkMaxBytes, this.file.size);
      const chunk = this.file.slice(offset, end);
      const controller = new AbortController();
      this.activeController = controller;

      try {
        await httpClient.patch(`/uploads/${this.session.uploadId}`, chunk, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Upload-Offset': String(offset),
          },
          signal: controller.signal,
          timeout: 120_000,
        });
        offset = end;
        this.sentBytes = offset;
        this.emitProgress();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // paused/cancelled — handled at loop top
          continue;
        }
        if ((error as { code?: string })?.code === 'ERR_CANCELED') {
          continue;
        }
        // offset conflict (409) — resync from server truth
        if ((error as { response?: { status?: number } })?.response?.status === 409) {
          offset = await this.queryServerOffset();
          this.sentBytes = offset;
          this.emitProgress();
          continue;
        }
        const apiError = (error as { response?: { data?: { message?: string; code?: string } } })?.response?.data;
        this.onEvent({
          type: 'error',
          message: apiError?.message ?? '上传分块失败',
          code: apiError?.code ?? 'CHUNK_ERROR',
        });
        throw error;
      }
    }

    if (this.cancelled) {
      throw new UploadCancelledError();
    }
    const result = await this.complete();
    this.onEvent({ type: 'completed', result });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.activeController?.abort();
    try {
      await httpClient.delete(`/uploads/${this.session.uploadId}`);
    } catch {
      // best-effort server cleanup
    }
  }

  pause(): void {
    this.paused = true;
    this.activeController?.abort();
  }

  resume(): void {
    this.paused = false;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private async complete(): Promise<CompleteResult> {
    const resp = await httpClient.post(`/uploads/${this.session.uploadId}/complete`, {
      expected_size: this.file.size,
    });
    return resp.data as CompleteResult;
  }

  private async queryServerOffset(): Promise<number> {
    const resp = await httpClient.head(`/uploads/${this.session.uploadId}`);
    const offset = Number(resp.headers['upload-offset'] ?? '0');
    return Number.isFinite(offset) ? offset : 0;
  }

  private emitProgress(): void {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const speed = elapsed > 0 ? this.sentBytes / elapsed : 0;
    this.onEvent({ type: 'progress', sent: this.sentBytes, total: this.file.size, speed });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create an upload session on the server (POST /uploads).
 * `purpose` is Phase 07: PUBLISH (default, scene upload) or RECONSTRUCT
 * (3DGS reconstruction input, accepts video + photo formats).
 */
export async function createUploadSession(
  meta: {
    filename: string;
    mime_type: string;
    size: number;
    format: string;
    title: string;
    description?: string | null;
    visibility: string;
    category: string;
    purpose?: string;
  },
): Promise<UploadSessionInfo> {
  const resp = await httpClient.post('/uploads', meta);
  return resp.data as UploadSessionInfo;
}
