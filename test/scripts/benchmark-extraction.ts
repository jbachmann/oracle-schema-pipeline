import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { OracleCatalog } from '../../src/catalog.js';
import { extractSource } from '../../src/extract.js';
import {
  benchmarkConnection,
  type Workload,
} from '../helpers/benchmark-catalog.js';

const workloads: Workload[] = [
  { tables: 1, constraints: 1, indexes: 1, viewDepth: 0, latencyMs: 0 },
  { tables: 20, constraints: 8, indexes: 8, viewDepth: 4, latencyMs: 0 },
  { tables: 20, constraints: 8, indexes: 8, viewDepth: 4, latencyMs: 2 },
  { tables: 4, constraints: 40, indexes: 40, viewDepth: 2, latencyMs: 2 },
];
if (process.argv[2] !== '--worker') {
  const sizes = process.argv[2] ? [Number(process.argv[2])] : [1, 16, 32, 64];
  const hashes = new Map<number, string>();
  for (const batchSize of sizes)
    for (let index = 0; index < workloads.length; index++) {
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          import.meta.filename,
          '--worker',
          String(batchSize),
          String(index),
        ],
        { encoding: 'utf8' },
      );
      if (child.status !== 0)
        throw new Error(child.stderr || 'Benchmark worker failed');
      const result = JSON.parse(child.stdout);
      if (hashes.has(index) && hashes.get(index) !== result.metadataSha256)
        throw new Error('Batching changed benchmark metadata');
      hashes.set(index, result.metadataSha256);
      process.stdout.write(child.stdout);
    }
} else {
  const workload = workloads[Number(process.argv[4])];
  const batchSize = Number(process.argv[3]);
  const { connection, stats } = benchmarkConnection(workload);
  const start = performance.now();
  const document = await extractSource(
    new OracleCatalog(connection, 'dba', undefined, batchSize),
    {
      version: 2,
      tables: Array.from({ length: workload.tables }, (_, i) => ({
        owner: i % 2 ? 'Owner B' : 'Owner "A',
        name: `T${i}`,
      })),
      views: workload.viewDepth ? [{ owner: 'Owner "A', name: 'V0' }] : [],
    },
  );
  const elapsedMs = performance.now() - start;
  const { extractedAt: _, ...metadata } = document;
  console.log(
    JSON.stringify({
      workload,
      batchSize,
      ...stats(),
      peakProcessRssBytes: process.resourceUsage().maxRSS * 1024,
      elapsedMs,
      metadataSha256: createHash('sha256')
        .update(JSON.stringify(metadata))
        .digest('hex'),
    }),
  );
}
