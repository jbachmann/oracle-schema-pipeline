import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyCompletion } from '../src/completion.js';
import { publishArtifacts, writeNewBuffer, writeJson } from '../src/files.js';
import { assertValidTarget } from '../src/validate.js';
import { generatedReplay } from './compose-destination.js';
import { CloneError } from './process.js';

const digest = (role: string) =>
  z
    .object({
      role: z.literal(role),
      bytes: z.number().int().nonnegative().safe(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
export const retryInputSchema = z
  .object({
    version: z.literal(1),
    artifacts: z.tuple([digest('sql'), digest('target'), digest('report')]),
  })
  .strict();
const hash = (contents: Buffer) =>
  createHash('sha256').update(contents).digest('hex');
export class RetryInputError extends CloneError {
  constructor(public readonly guidance: string) {
    super('CLONE_RETRY_INPUT_INVALID');
  }
}
const decode = (contents: Buffer) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents);

export async function prepareRetryInput(input: string, directory: string) {
  const expected = (dir: string) =>
    ['target', 'report'].map((role) => ({
      role,
      path: join(dir, `${role}.json`),
    }));
  const completion = (dir: string) => join(dir, 'target.json.complete.json');
  // The source directory is a stable, trusted local publication bundle.
  await verifyCompletion(completion(input), expected(input));
  const artifacts: { role: string; path: string; contents: Buffer }[] = [];
  for (const [role, name] of [
    ['sql', 'clone.sql'],
    ['target', 'target.json'],
    ['report', 'report.json'],
  ]) {
    try {
      artifacts.push({
        role,
        path: join(directory, name),
        contents: await readFile(join(input, name)),
      });
    } catch {
      throw new RetryInputError(
        `Cannot read ${name}; supply a complete clone artifacts folder.`,
      );
    }
  }
  // Recheck canonical paths and bind the retained bytes to the manifest.
  await verifyCompletion(
    completion(input),
    expected(input).map((artifact, index) => ({
      ...artifact,
      contents: artifacts[index + 1].contents,
    })),
  );
  let sql, target;
  try {
    sql = generatedReplay(decode(artifacts[0].contents));
  } catch {
    throw new RetryInputError(
      'clone.sql must be UTF-8 with the current format-6 generated preamble. Re-extract the source and create a fresh clone bundle; saved SQL is never upgraded.',
    );
  }
  try {
    target = assertValidTarget(JSON.parse(decode(artifacts[1].contents)));
  } catch {
    throw new RetryInputError(
      'target.json must use format 6 and pass target validation. Re-extract older artifacts and create a fresh clone bundle.',
    );
  }
  try {
    JSON.parse(decode(artifacts[2].contents));
  } catch {
    throw new RetryInputError('report.json must contain valid UTF-8 JSON.');
  }
  const options = { tempDir: join(directory, '.staging') };
  await writeNewBuffer(artifacts[0].path, artifacts[0].contents, options);
  await publishArtifacts(artifacts.slice(1), completion(directory), options);
  await writeJson(
    join(directory, 'retry-input.json'),
    retryInputSchema.parse({
      version: 1,
      artifacts: artifacts.map(({ role, contents }) => ({
        role,
        bytes: contents.length,
        sha256: hash(contents),
      })),
    }),
    options,
  );
  await verifyCompletion(completion(directory), expected(directory));
  return { sql, target };
}
