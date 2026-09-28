/**
 * Verify published artifact bundles before consumers use them. Publication in
 * files.ts is atomic per file, so transform writes a completion manifest last
 * to describe the finished bundle. The clone workflow uses this verifier to
 * check that its expected artifacts match the manifest before using the target.
 * This checks publication integrity; model validation still handles semantics.
 * See ADR 0005 for the publication protocol and filesystem assumptions.
 */
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OutputError } from './files.js';

// The manifest has its own version, independent of the model's formatVersion.
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

/**
 * Match the manifest to the caller's ordered roles and paths, then verify each
 * file's byte length and SHA-256 digest. Read only caller-supplied paths, never
 * arbitrary paths supplied by a manifest. Optional caller-retained contents are
 * checked instead of rereading the file, while canonical paths are still verified.
 * Missing, invalid, or mismatched data
 * rejects with OUTPUT_INCOMPLETE and preserves the underlying error as its cause.
 */
export async function verifyCompletion(
  completionPath: string,
  expected: { role: string; path: string; contents?: Uint8Array }[],
): Promise<void> {
  try {
    const manifest = completionSchema.parse(
      JSON.parse(await readFile(completionPath, 'utf8')),
    );
    if (manifest.artifacts.length !== expected.length) {
      throw new Error('Artifact count differs from the expected bundle.');
    }
    for (let index = 0; index < expected.length; index++) {
      const artifact = manifest.artifacts[index];
      const expectedArtifact = expected[index];
      // Publication records canonical paths; resolve the caller's path to match.
      const artifactPath = await realpath(expectedArtifact.path);
      if (
        artifact.role !== expectedArtifact.role ||
        artifact.path !== artifactPath
      ) {
        throw new Error(
          'Artifact role or path differs from the expected bundle.',
        );
      }
      const contents =
        expectedArtifact.contents ?? (await readFile(artifactPath));
      const sha256 = createHash('sha256').update(contents).digest('hex');
      if (
        artifact.bytes !== contents.byteLength ||
        artifact.sha256 !== sha256
      ) {
        throw new Error(
          'Artifact length or hash differs from the completion manifest.',
        );
      }
    }
  } catch (error) {
    throw new OutputError(
      'OUTPUT_INCOMPLETE',
      `Cannot verify complete bundle at ${completionPath}. ${error instanceof Error ? error.message : ''}`,
      { cause: error },
    );
  }
}
