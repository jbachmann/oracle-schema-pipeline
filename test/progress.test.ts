import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'oracledb';
import { OracleCatalog } from '../src/catalog.js';
import { extractSource } from '../src/extract.js';
import { ExtractionProgress, type ProgressEvent } from '../src/progress.js';
import { benchmarkConnection } from './helpers/benchmark-catalog.js';

const selection = {
  version: 2 as const,
  tables: [{ owner: 'APP', name: 'T' }],
  views: [],
};
const workload = {
  tables: 1,
  constraints: 3,
  indexes: 3,
  viewDepth: 0,
  latencyMs: 0,
};

test('opt-in events preserve metadata, report ordered query timing and row counts under one run', async () => {
  const events: ProgressEvent[] = [];
  const progress = new ExtractionProgress((event) => events.push(event));
  const observed = await extractSource(
    new OracleCatalog(
      benchmarkConnection(workload).connection,
      'dba',
      progress,
    ),
    selection,
    progress,
  );
  const silent = await extractSource(
    new OracleCatalog(benchmarkConnection(workload).connection, 'dba'),
    selection,
  );
  assert.deepEqual(
    { ...observed, extractedAt: '' },
    { ...silent, extractedAt: '' },
  );
  assert.equal(events[0].stage, 'extract');
  assert.equal(events[0].event, 'start');
  assert.equal(events.at(-1)!.event, 'complete');
  assert.equal(events.at(-1)!.stage, 'extract');
  assert.equal(new Set(events.map((event) => event.runId)).size, 1);
  const queries = events.filter((event) => event.stage === 'query');
  assert.deepEqual(queries[0].object, selection.tables[0]);
  assert.deepEqual(
    queries
      .filter((event) => event.event === 'start')
      .map((event) => event.queryCategory),
    [
      'constraints',
      'constraint-columns',
      'table',
      'table-comments',
      'identities',
      'columns',
      'column-comments',
      'indexes',
      'index-expressions',
      'index-columns',
      'prerequisites',
      'database-version',
    ],
  );
  for (let i = 0; i < queries.length; i += 2) {
    assert.equal(queries[i].event, 'start');
    assert.equal(queries[i + 1].event, 'complete');
    assert.equal(queries[i].queryCategory, queries[i + 1].queryCategory);
    assert.ok(queries[i + 1].elapsedMs >= queries[i].elapsedMs);
    assert.ok(Number.isInteger(queries[i + 1].rows));
  }
});

for (const failure of ['execute', 'fetch', 'close', 'decode']) {
  test(`query ${failure} failure emits a safe code and extract failure, never raw diagnostics`, async () => {
    const events: ProgressEvent[] = [];
    const progress = new ExtractionProgress((event) => events.push(event));
    const secret =
      'password=secret (DESCRIPTION=private) SELECT secret FROM private';
    const error = Object.assign(new Error(secret), { code: secret });
    let closed = false;
    const connection = {
      async execute() {
        if (failure === 'execute') throw error;
        return {
          resultSet: {
            async getRows() {
              if (failure === 'fetch') throw error;
              return failure === 'decode' ? [{}] : [];
            },
            async close() {
              closed = true;
              if (failure === 'close') throw error;
            },
          },
        };
      },
    } as unknown as Connection;
    await assert.rejects(
      extractSource(
        new OracleCatalog(connection, 'dba', progress),
        selection,
        progress,
      ),
    );
    assert.equal(closed, failure !== 'execute');
    assert.equal(events.at(-1)!.stage, 'extract');
    assert.equal(events.at(-1)!.event, 'failure');
    const queryFailure = events.find(
      (event) => event.stage === 'query' && event.event === 'failure',
    )!;
    assert.equal(
      queryFailure.errorCode,
      failure === 'decode'
        ? 'CATALOG_INCOMPLETE_METADATA'
        : 'EXTRACTION_FAILED',
    );
    assert.ok(queryFailure.elapsedMs >= 0);
    assert.ok(!JSON.stringify(events).includes(secret));
    assert.ok(
      events.every(
        (event) =>
          !('sql' in event) && !('binds' in event) && !('message' in event),
      ),
    );
  });
}

test('observer failures cannot change extraction or mask catalog errors', async () => {
  const progress = new ExtractionProgress(() => {
    throw new Error('observer failed');
  });
  const result = await extractSource(
    new OracleCatalog(
      benchmarkConnection(workload).connection,
      'dba',
      progress,
    ),
    selection,
    progress,
  );
  assert.equal(result.tables.length, 1);
  const original = new Error('original');
  await assert.rejects(
    progress.measure('extract', async () => {
      throw original;
    }),
    (error) => error === original,
  );
});

test('observer object references are isolated from the extraction selection', async () => {
  const input = structuredClone(selection);
  const progress = new ExtractionProgress((event) => {
    if (event.object) event.object.name = 'CHANGED';
  });
  const result = await extractSource(
    new OracleCatalog(
      benchmarkConnection(workload).connection,
      'dba',
      progress,
    ),
    input,
    progress,
  );
  assert.deepEqual(input, selection);
  assert.equal(result.tables[0].reference.name, 'T');
});
