import { open, copyFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';

/** Preserve existing files. A failed write leaves a .partial file, not valid output. */
export async function writeNewFile(
  path: string,
  contents: string,
): Promise<void> {
  await writeNewBuffer(path, Buffer.from(contents, 'utf8'));
}
export async function writeNewBuffer(
  path: string,
  contents: Uint8Array,
): Promise<void> {
  const partial = `${path}.partial`;
  const handle = await open(partial, 'wx');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await copyFile(partial, path, constants.COPYFILE_EXCL);
  await unlink(partial);
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeNewFile(path, JSON.stringify(value, null, 2) + '\n');
}
