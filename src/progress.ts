import { randomUUID } from 'node:crypto';
import type { ObjectReference } from './model.js';

export type QueryCategory =
  | 'database-version'
  | 'constraints'
  | 'constraint-columns'
  | 'table'
  | 'table-comments'
  | 'identities'
  | 'columns'
  | 'column-comments'
  | 'indexes'
  | 'index-expressions'
  | 'index-columns'
  | 'view'
  | 'view-columns'
  | 'view-restrictions'
  | 'view-dependencies'
  | 'prerequisites';
export type ProgressStage =
  | 'extract'
  | 'password'
  | 'connection'
  | 'publication'
  | 'object'
  | 'query'
  | 'cli';
export interface ProgressEvent {
  version: 1;
  runId: string;
  stage: ProgressStage;
  event: 'start' | 'complete' | 'failure';
  queryCategory?: QueryCategory;
  object?: ObjectReference;
  elapsedMs: number;
  rows?: number;
  errorCode?: string;
}
export type ProgressCallback = (event: ProgressEvent) => void;

/** Never forward driver messages, SQL, binds, or arbitrary error codes. */
export function progressErrorCode(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  return typeof code === 'string' &&
    [
      'CATALOG_UNKNOWN_VALUE',
      'CATALOG_CARDINALITY',
      'CATALOG_INCOMPLETE_METADATA',
    ].includes(code)
    ? code
    : 'EXTRACTION_FAILED';
}

export class ExtractionProgress {
  readonly runId = randomUUID();
  constructor(private readonly callback?: ProgressCallback) {}

  async measure<T>(
    stage: ProgressStage,
    operation: () => Promise<T>,
    details: { queryCategory?: QueryCategory; object?: ObjectReference } = {},
    rowCount?: (value: T) => number,
  ): Promise<T> {
    if (!this.callback) return operation();
    const started = performance.now();
    const emit = (
      event: ProgressEvent['event'],
      extra: Partial<ProgressEvent> = {},
    ) => {
      // Observers are best-effort and cannot change extraction or mask failures.
      try {
        this.callback!({
          version: 1,
          runId: this.runId,
          stage,
          event,
          ...details,
          ...(details.object ? { object: { ...details.object } } : {}),
          elapsedMs: performance.now() - started,
          ...extra,
        });
      } catch {
        /* Ignore observer failures. */
      }
    };
    emit('start');
    try {
      const value = await operation();
      emit('complete', rowCount ? { rows: rowCount(value) } : {});
      return value;
    } catch (error) {
      emit('failure', { errorCode: progressErrorCode(error) });
      throw error;
    }
  }
}
