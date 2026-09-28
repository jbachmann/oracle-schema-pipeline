import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PreflightProgress,
  CloneExtractionProgress,
  parsePullLine,
  formatPreflight,
  type PreflightEvent,
  type ProgressClock,
} from '../scripts/clone-progress.js';

function fakeClock() {
  let now = 0,
    id = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const clock: ProgressClock = {
    now: () => now,
    schedule: (callback, delay) => {
      timers.set(++id, { due: now + delay, callback });
      return id;
    },
    cancel: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    timers,
    tick(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}
test('fast checks complete without heartbeat; nested checks only heartbeat the innermost operation', async () => {
  const time = fakeClock(),
    events: PreflightEvent[] = [];
  const progress = new PreflightProgress(
    (event) => events.push(event),
    time.clock,
  );
  await progress.operation('endpoint', async () => time.tick(100));
  assert.deepEqual(
    events.map((event) => event.event),
    ['start', 'complete'],
  );
  await progress.operation('image', async () => {
    await progress.pull(async () => time.tick(20_000));
    time.tick(10_000);
  });
  assert.deepEqual(
    events
      .filter((event) => event.event === 'heartbeat')
      .map((event) => [event.operation, event.elapsedMs]),
    [
      ['image-pull', 10_000],
      ['image-pull', 20_000],
      ['image', 30_000],
    ],
  );
  assert.equal(time.timers.size, 0);
  const count = events.length;
  time.tick(30_000);
  assert.equal(events.length, count);
});
test('pull updates coalesce per layer, flush on rejection, and ignore late input', async () => {
  const time = fakeClock(),
    events: PreflightEvent[] = [];
  let late!: (line: string) => void;
  const progress = new PreflightProgress(
    (event) => events.push(event),
    time.clock,
  );
  const failure = new Error('private-secret');
  await assert.rejects(
    progress.pull(async (line) => {
      late = line;
      line('abcdef123456: Downloading 1MB/10MB');
      line('abcdef123456: Downloading 2MB/10MB');
      line('123456abcdef: Waiting');
      time.tick(999);
      assert.equal(events.filter((event) => event.event === 'layer').length, 0);
      time.tick(1);
      assert.equal(events.filter((event) => event.event === 'layer').length, 2);
      line('abcdef123456: Download complete');
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(events.at(-2)?.event, 'layer');
  assert.equal(events.at(-1)?.event, 'failure');
  assert.doesNotMatch(events.map(formatPreflight).join('\n'), /private-secret/);
  const count = events.length;
  late('abcdef123456: Pull complete');
  time.tick(30_000);
  assert.equal(events.length, count);
  assert.equal(time.timers.size, 0);
});
test('observer exceptions cannot alter success or the original failure', async () => {
  const time = fakeClock();
  const progress = new PreflightProgress(() => {
    throw Error('observer');
  }, time.clock);
  assert.equal(
    await progress.pull(async (line) => {
      line('abcdef123456: Pull complete');
      time.tick(10_000);
      return 'ok';
    }),
    'ok',
  );
  const error = Error('operation');
  await assert.rejects(
    progress.operation('daemon', async () => {
      throw error;
    }),
    (actual) => actual === error,
  );
  assert.equal(time.timers.size, 0);
});
test('pull parsing accepts only layer statuses and valid finite counters', () => {
  assert.deepEqual(
    parsePullLine('\x1b[2Kabcdef123456: Downloading [==>   ] 1.5MB/2MB\x1b[0m'),
    {
      layerId: 'abcdef123456',
      status: 'downloading',
      currentBytes: 1_500_000,
      totalBytes: 2_000_000,
    },
  );
  assert.equal(
    parsePullLine('ABCDEF123456: Extracting 1KiB/2KiB')?.currentBytes,
    1024,
  );
  for (const status of [
    'Pulling fs layer',
    'Waiting',
    'Downloading',
    'Verifying Checksum',
    'Download complete',
    'Extracting',
    'Pull complete',
    'Already exists',
  ])
    assert.ok(parsePullLine(`abcdef123456: ${status}`));
  for (const line of [
    'secret: Waiting',
    'abcdef123456: password=private-secret',
    'abcdef123456: Waiting private-secret',
    'abcdef123456: Downloading -1MB/2MB',
    'abcdef123456: Downloading 3MB/2MB',
    'abcdef123456: Downloading NaNMB/2MB',
    'abcdef123456: Downloading 1MB/InfinityMB',
    'abcdef123456: Downloading 1XB/2XB',
    'abcdef123456: Pull complete 1B/2B',
    `abcdef123456: Downloading ${'9'.repeat(400)}MB/2MB`,
    'registry/private-secret',
    'abcdef123456: Waiting\nprivate-secret',
  ])
    assert.equal(parsePullLine(line), undefined, line);
});
test('layer backlog is bounded even for arbitrary numbers of valid layer identifiers', async () => {
  const time = fakeClock(),
    events: PreflightEvent[] = [];
  await new PreflightProgress((event) => events.push(event), time.clock).pull(
    async (line) => {
      for (let i = 0; i < 1000; i++)
        line(`${i.toString(16).padStart(12, '0')}: Waiting`);
    },
  );
  assert.equal(events.filter((event) => event.event === 'layer').length, 256);
});

for (const outcome of ['success', 'failure', 'interruption']) {
  test(`extraction reports activity during silence and stops after ${outcome}`, async () => {
    const time = fakeClock(),
      logs: string[] = [];
    const progress = new CloneExtractionProgress(
      (line) => logs.push(line),
      time.clock,
    );
    let late!: (line: string) => void;
    const failure = Error(outcome);
    const result = progress.run(async (line) => {
      late = line;
      const event = (stage: string, event: string) =>
        line(
          JSON.stringify({
            version: 1,
            stage,
            event,
            object: 'private-secret',
          }),
        );
      event('extract', 'start');
      event('query', 'start');
      time.tick(10_000);
      assert.equal(
        logs.at(-1),
        'Extraction extract: still running (10s elapsed; 0 queries completed; 0 objects completed)',
      );
      for (let i = 0; i < 100; i++) event('query', 'complete');
      event('object', 'complete');
      assert.equal(logs.length, 2);
      time.tick(10_000);
      assert.equal(
        logs.at(-1),
        'Extraction extract: still running (20s elapsed; 100 queries completed; 1 objects completed)',
      );
      for (const raw of [
        'null',
        '{}',
        'private-secret',
        '{',
        JSON.stringify({ version: 1, stage: 'private-secret', event: 'start' }),
      ])
        line(raw);
      if (outcome !== 'success') throw failure;
      event('extract', 'complete');
      return 'ok';
    });
    if (outcome === 'success') {
      assert.equal(await result, 'ok');
      assert.equal(
        logs.at(-1),
        'Extraction extract: complete (20s elapsed; 100 queries completed; 1 objects completed)',
      );
    } else await assert.rejects(result, (error) => error === failure);
    const count = logs.length;
    late(JSON.stringify({ version: 1, stage: 'extract', event: 'start' }));
    time.tick(30_000);
    assert.equal(logs.length, count);
    assert.equal(time.timers.size, 0);
    assert.doesNotMatch(logs.join(), /private-secret/);
  });
}

test('extraction observer failures do not affect child outcome', async () => {
  const time = fakeClock();
  assert.equal(
    await new CloneExtractionProgress(() => {
      throw Error('logger');
    }, time.clock).run(async (line) => {
      line(JSON.stringify({ version: 1, stage: 'extract', event: 'start' }));
      time.tick(10_000);
      return 'ok';
    }),
    'ok',
  );
  assert.equal(time.timers.size, 0);
});
