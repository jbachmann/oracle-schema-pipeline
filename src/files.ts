import { open, copyFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';

/** Preserve existing files. A failed write leaves a .partial file, not valid output. */
export async function writeNewFile(path: string, contents: string): Promise<void> {
  const partial = `${path}.partial`;
  const handle = await open(partial, 'wx');
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await copyFile(partial, path, constants.COPYFILE_EXCL);
  await unlink(partial);
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeNewFile(path, JSON.stringify(value, null, 2) + '\n');
}
