import { fileURLToPath } from 'node:url';
import { cloneDatabase } from './clone-workflow.js';
const controller = new AbortController();
const abort = () => controller.abort();
process.on('SIGINT', abort);
process.on('SIGTERM', abort);
try {
  const { result } = await cloneDatabase({
    root: fileURLToPath(new URL('../', import.meta.url)),
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
