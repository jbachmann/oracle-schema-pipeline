import { stripVTControlCharacters } from 'node:util';

export type PreflightOperation =
  'endpoint' | 'daemon' | 'compose' | 'image' | 'image-pull' | 'identity';
const labels: Record<PreflightOperation, string> = {
  endpoint: 'Docker endpoint',
  daemon: 'Docker daemon',
  compose: 'Docker Compose',
  image: 'Oracle image availability',
  'image-pull': 'Oracle image download',
  identity: 'Destination identity',
};
const statuses = [
  'pulling fs layer',
  'waiting',
  'downloading',
  'verifying checksum',
  'download complete',
  'extracting',
  'pull complete',
  'already exists',
] as const;
export interface LayerProgress {
  layerId: string;
  status: (typeof statuses)[number];
  currentBytes?: number;
  totalBytes?: number;
}
export type PreflightEvent = {
  operation: PreflightOperation;
  elapsedMs: number;
} & (
  | { event: 'start' | 'complete' | 'failure' | 'heartbeat' }
  | ({ event: 'layer' } & LayerProgress)
);
export type PreflightObserver = (event: PreflightEvent) => void;
export interface ProgressClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}
const clock: ProgressClock = {
  now: () => performance.now(),
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export function observe(
  observer: PreflightObserver | undefined,
  event: PreflightEvent,
): void {
  try {
    observer?.(event);
  } catch {
    /* Progress cannot change orchestration. */
  }
}
export function parsePullLine(raw: string): LayerProgress | undefined {
  if (raw.length > 64_000) return;
  const line = stripVTControlCharacters(raw).trim();
  const match =
    /^([a-fA-F0-9]{12,64}): (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)(?:\s+\[[=> ]*\])?(?:\s+(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)\s*\/\s*(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB))?$/.exec(
      line,
    );
  if (!match) return;
  const status = match[2].toLowerCase() as LayerProgress['status'];
  const result: LayerProgress = { layerId: match[1].toLowerCase(), status };
  if (match[3] !== undefined) {
    if (status !== 'downloading' && status !== 'extracting') return;
    const units: Record<string, number> = {
      B: 1,
      kB: 1e3,
      MB: 1e6,
      GB: 1e9,
      TB: 1e12,
      KiB: 1024,
      MiB: 1024 ** 2,
      GiB: 1024 ** 3,
      TiB: 1024 ** 4,
    };
    result.currentBytes = Number(match[3]) * units[match[4]];
    result.totalBytes = Number(match[5]) * units[match[6]];
    if (
      !Number.isFinite(result.currentBytes) ||
      !Number.isFinite(result.totalBytes) ||
      result.currentBytes > result.totalBytes
    )
      return;
  }
  return result;
}
export function formatPreflight(event: PreflightEvent): string {
  const seconds = `${Number((event.elapsedMs / 1000).toFixed(1))}s`;
  if (event.event === 'layer') {
    const bytes = (value: number) =>
      value >= 1e6 ? `${Number((value / 1e6).toFixed(2))} MB` : `${value} B`;
    return `Preflight: layer ${event.layerId} — ${event.status}${event.currentBytes === undefined || event.totalBytes === undefined ? '' : ` ${bytes(event.currentBytes)} / ${bytes(event.totalBytes)}`}`;
  }
  const state =
    event.event === 'start'
      ? 'starting'
      : event.event === 'heartbeat'
        ? `still running (${seconds} elapsed)`
        : `${event.event === 'failure' ? 'failed' : 'complete'} (${seconds})`;
  return `Preflight: ${labels[event.operation]} — ${state}`;
}
/** One instance per preflight; nested operations suspend the parent's heartbeat. */
export class PreflightProgress {
  private active?: object;
  constructor(
    private observer?: PreflightObserver,
    private time: ProgressClock = clock,
  ) {}
  async operation<T>(
    operation: PreflightOperation,
    work: () => Promise<T>,
  ): Promise<T> {
    const parent = this.active,
      scope = {};
    this.active = scope;
    const start = this.time.now();
    const emit = (event: 'start' | 'heartbeat' | 'complete' | 'failure') =>
      observe(this.observer, {
        operation,
        event,
        elapsedMs: Math.max(0, this.time.now() - start),
      });
    let timer: unknown;
    let settled = false;
    const heartbeat = () => {
      if (settled) return;
      if (this.active === scope) emit('heartbeat');
      timer = this.time.schedule(heartbeat, 10_000);
    };
    emit('start');
    if (this.observer) timer = this.time.schedule(heartbeat, 10_000);
    try {
      const result = await work();
      emit('complete');
      return result;
    } catch (error) {
      emit('failure');
      throw error;
    } finally {
      settled = true;
      this.time.cancel(timer);
      this.active = parent;
    }
  }
  async pull<T>(
    work: (line: (line: string) => void) => Promise<T>,
  ): Promise<T> {
    return this.operation('image-pull', async () => {
      const start = this.time.now();
      const pending = new Map<string, LayerProgress>();
      let timer: unknown;
      let scheduled = false,
        settled = false;
      const flush = () => {
        scheduled = false;
        for (const layer of pending.values())
          observe(this.observer, {
            operation: 'image-pull',
            event: 'layer',
            elapsedMs: Math.max(0, this.time.now() - start),
            ...layer,
          });
        pending.clear();
      };
      try {
        return await work((line) => {
          if (settled || !this.observer) return;
          const layer = parsePullLine(line);
          if (!layer || (!pending.has(layer.layerId) && pending.size >= 256))
            return;
          pending.set(layer.layerId, layer);
          if (!scheduled) {
            scheduled = true;
            timer = this.time.schedule(flush, 1000);
          }
        });
      } finally {
        settled = true;
        this.time.cancel(timer);
        flush();
      }
    });
  }
}
