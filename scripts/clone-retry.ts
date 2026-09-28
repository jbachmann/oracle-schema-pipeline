import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { retryCloneDatabase } from './clone-workflow.js';

const usage =
  'Usage: npm run db:clone-retry -- <artifacts-folder>\nRebuilds the disposable local destination from saved clone.sql, target.json, report.json and target.json.complete.json. This resets the local destination.';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else if (args.length !== 1 || args[0].startsWith('-')) {
  console.error(
    `CLONE_RETRY_USAGE: supply exactly one artifacts directory.\n${usage}`,
  );
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    const { result } = await retryCloneDatabase({
      root: fileURLToPath(new URL('../', import.meta.url)),
      input: resolve(args[0]),
      signal: controller.signal,
    });
    process.exitCode = result.status === 'succeeded' ? 0 : 1;
  } catch {
    console.error('CLONE_STAGE_FAILED: unable to publish run artifacts.');
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
