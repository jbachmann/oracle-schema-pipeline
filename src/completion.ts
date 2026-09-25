import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OutputError } from './files.js';

const completionSchema = z
  .object({
    version: z.literal(1),
    artifacts: z.array(
      z
        .object({
          role: z.string().min(1),
          path: z.string().min(1),
          bytes: z.number().int().nonnegative().safe(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict(),
    ),
  })
  .strict();

/** Verify the intended bundle, never read arbitrary paths supplied by a manifest. */
export async function verifyCompletion(
  completion: string,
  expected: { role: string; path: string }[],
): Promise<void> {
  try {
    const manifest = completionSchema.parse(
      JSON.parse(await readFile(completion, 'utf8')),
    );
    if (manifest.artifacts.length !== expected.length)
      throw new Error('Artifact count differs from the expected bundle.');
    for (let index = 0; index < expected.length; index++) {
      const artifact = manifest.artifacts[index];
      const path = await realpath(expected[index].path);
      if (artifact.role !== expected[index].role || artifact.path !== path)
        throw new Error(
          'Artifact role or path differs from the expected bundle.',
        );
      const bytes = await readFile(path);
      if (
        artifact.bytes !== bytes.byteLength ||
        artifact.sha256 !== createHash('sha256').update(bytes).digest('hex')
      )
        throw new Error(
          'Artifact length or hash differs from the completion manifest.',
        );
    }
  } catch (error) {
    throw new OutputError(
      'OUTPUT_INCOMPLETE',
      `Cannot verify complete bundle at ${completion}. ${error instanceof Error ? error.message : ''}`,
      { cause: error },
    );
  }
}
