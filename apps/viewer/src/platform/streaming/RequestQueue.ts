import type { ChunkKey, ChunkRequestState } from './types';

/**
 * Min-heap priority queue for chunk requests.
 *
 * Requests are ordered by an externally-computed `priority` score (higher =
 * more urgent). The scheduler re-scores all pending requests whenever the
 * camera moves or the LOD target changes, so the queue exposes re-prioritize.
 *
 * Thread-safety is not a concern: this runs on the host (web app) thread
 * alongside the frame loop, and every mutation happens synchronously.
 */
export class RequestQueue {
    private readonly heap: Array<{
        key: string;
        chunk: ChunkKey;
        priority: number;
        state: ChunkRequestState;
    }> = [];
    private readonly index = new Map<string, number>();

    /** Number of queued (pending) requests. */
    get size(): number {
        return this.heap.length;
    }

    /**
     * Push a request with an initial priority. If the key already exists the
     * priority is updated (and the heap re-sorted) instead of duplicating.
     */
    push(key: string, chunk: ChunkKey, priority: number, state: ChunkRequestState = { state: 'pending' }): void {
        const existing = this.index.get(key);
        if (existing !== undefined) {
            this.heap[existing].priority = priority;
            this.heap[existing].state = state;
            // Re-heapify: siftDown handles priority decrease, siftUp handles increase.
            this.siftDown(existing);
            this.siftUp(existing);
            return;
        }
        const node = { key, chunk, priority, state };
        this.heap.push(node);
        const at = this.heap.length - 1;
        this.index.set(key, at);
        this.siftUp(at);
    }

    /**
     * Pop the highest-priority request (max-heap: priority compared ascending).
     * Returns null when empty.
     */
    pop(): { key: string; chunk: ChunkKey; priority: number } | null {
        if (this.heap.length === 0) return null;
        const top = this.heap[0];
        const last = this.heap.pop()!;
        this.index.delete(top.key);
        if (this.heap.length > 0 && last !== top) {
            this.heap[0] = last;
            this.index.set(last.key, 0);
            this.siftDown(0);
        }
        return { key: top.key, chunk: top.chunk, priority: top.priority };
    }

    /**
     * Peek at the highest-priority request without removing it.
     */
    peek(): { key: string; chunk: ChunkKey; priority: number } | null {
        if (this.heap.length === 0) return null;
        const top = this.heap[0];
        return { key: top.key, chunk: top.chunk, priority: top.priority };
    }

    /**
     * Remove a request by key. Returns true if it was present.
     */
    remove(key: string): boolean {
        const at = this.index.get(key);
        if (at === undefined) return false;
        const last = this.heap.pop()!;
        this.index.delete(key);
        if (at < this.heap.length) {
            this.heap[at] = last;
            this.index.set(last.key, at);
            // the replacement may need to move either way
            this.siftUp(at);
            this.siftDown(at);
        }
        return true;
    }

    /**
     * Remove every request.
     */
    clear(): void {
        this.heap.length = 0;
        this.index.clear();
    }

    /**
     * Update the state of a request in place (e.g. pending -> fetching).
     */
    setState(key: string, state: ChunkRequestState): void {
        const at = this.index.get(key);
        if (at !== undefined) this.heap[at].state = state;
    }

    /** All keys currently in the queue (any state). */
    keys(): string[] {
        return [...this.index.keys()];
    }

    /** Whether a key is present. */
    has(key: string): boolean {
        return this.index.has(key);
    }

    // -- heap internals ------------------------------------------------------

    private siftUp(start: number): void {
        let i = start;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.heap[parent].priority >= this.heap[i].priority) break;
            this.swap(i, parent);
            i = parent;
        }
    }

    private siftDown(start: number): void {
        let i = start;
        const n = this.heap.length;
        while (true) {
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            let largest = i;
            if (l < n && this.heap[l].priority > this.heap[largest].priority) largest = l;
            if (r < n && this.heap[r].priority > this.heap[largest].priority) largest = r;
            if (largest === i) break;
            this.swap(i, largest);
            i = largest;
        }
    }

    private swap(a: number, b: number): void {
        const tmp = this.heap[a];
        this.heap[a] = this.heap[b];
        this.heap[b] = tmp;
        this.index.set(this.heap[a].key, a);
        this.index.set(this.heap[b].key, b);
    }
}
