/**
 * Optional progress reporting shared by extraction, catalog queries, and the CLI.
 * Groups timed start, completion, and failure events under one run ID so callers
 * can track extraction activity without adding telemetry to schema artifacts.
 * Events expose only selected metadata and allowlisted error codes; observer and
 * row-count callback failures do not change the operation's outcome.
 */
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
  | 'index-dependencies'
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
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return 'EXTRACTION_FAILED';
  }

  const code = error.code;
  switch (code) {
    case 'UNSELECTED_VIEW_TABLE':
    case 'CATALOG_UNKNOWN_VALUE':
    case 'CATALOG_CARDINALITY':
    case 'CATALOG_INCOMPLETE_METADATA':
      return code;
    default:
      return 'EXTRACTION_FAILED';
  }
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
    const callback = this.callback;
    if (!callback) return operation();

    const started = performance.now();
    const emit = (
      event: ProgressEvent['event'],
      extra: Partial<Pick<ProgressEvent, 'rows' | 'errorCode'>> = {},
    ) => {
      // Observers are best-effort and cannot change extraction or mask failures.
      try {
        const progressEvent: ProgressEvent = {
          version: 1,
          runId: this.runId,
          stage,
          event,
          elapsedMs: performance.now() - started,
          ...extra,
        };
        if (details.queryCategory !== undefined) {
          progressEvent.queryCategory = details.queryCategory;
        }
        if (details.object) {
          progressEvent.object = { ...details.object };
        }
        callback(progressEvent);
      } catch {
        /* Ignore observer failures. */
      }
    };

    emit('start');
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      emit('failure', { errorCode: progressErrorCode(error) });
      throw error;
    }

    const completion: Partial<Pick<ProgressEvent, 'rows'>> = {};
    if (rowCount) {
      try {
        completion.rows = rowCount(value);
      } catch {
        // A reporting failure must not turn a successful operation into a failure.
      }
    }
    emit('complete', completion);
    return value;
  }
}
