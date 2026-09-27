/**
 * Shared output publication for the schema pipeline's JSON, SQL, and workbook
 * artifacts. Staging complete files before linking them into place prevents
 * readers from seeing partial contents and preserves the no-overwrite invariant.
 *
 * Atomic visibility applies to each path, not to a whole bundle. An optional
 * completion manifest is published last so consumers can verify the bundle's
 * paths, byte lengths, and hashes before using it. See ADR 0005 for the protocol
 * and its filesystem assumptions.
 */
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

export interface PublicationOptions {
  /** Staging root on the destination filesystem; defaults to .oracle-schema-tmp. */
  tempDir?: string;
  /** Receives durability and cleanup warnings; defaults to console.warn. */
  onWarning?: (message: string) => void;
}

/** One output's semantic role, destination, and already-rendered bytes. */
export interface Artifact {
  role: string;
  path: string;
  contents: Uint8Array;
}

type PreparedArtifact = Omit<Artifact, 'contents'> & { contents: Buffer };

/** Describes the ordered artifacts in a bundle, excluding the manifest itself. */
export interface CompletionManifest {
  version: 1;
  artifacts: { role: string; path: string; bytes: number; sha256: string }[];
}

/** Publication diagnostic with a stable code and, when available, its cause. */
export class OutputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

function publicationErrorCode(code: string | undefined): string {
  if (code === 'EEXIST') {
    return 'OUTPUT_EXISTS';
  }
  if (
    ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(code ?? '')
  ) {
    return 'OUTPUT_PUBLICATION_UNSUPPORTED';
  }
  return 'OUTPUT_PUBLICATION_FAILED';
}

/**
 * Create the preflight and publication operations used by the default writer.
 * Injecting filesystem operations lets tests exercise failures and races.
 */
export function createArtifactWriter(io = fs) {
  /**
   * Resolve destinations, reject existing or aliased paths, and prepare a
   * staging root on the same filesystem. Destination parents must already exist.
   * This does not reserve names; exclusive links enforce no-overwrite at publish.
   */
  async function preflight(paths: string[], options: PublicationOptions = {}) {
    const destinations = await Promise.all(
      paths.map(async (path) => {
        const resolvedPath = resolve(path);
        return join(
          await io.realpath(dirname(resolvedPath)),
          basename(resolvedPath),
        );
      }),
    );
    // Conservatively reject case/Unicode variants in the same directory, even
    // on case-sensitive disks, so aliases cannot become a partially published set.
    const identities = await Promise.all(
      destinations.map(async (path) => {
        const parent = await io.stat(dirname(path));
        return `${parent.dev}:${parent.ino}:${basename(path).normalize('NFD').toLowerCase()}`;
      }),
    );
    if (new Set(identities).size !== identities.length) {
      throw new OutputError(
        'OUTPUT_PATH_CONFLICT',
        'Artifact destinations must be distinct.',
      );
    }
    for (const path of destinations) {
      try {
        await io.lstat(path); // Includes dangling symlinks.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      throw new OutputError('OUTPUT_EXISTS', `Output exists: ${path}`);
    }
    const tempDir = resolve(options.tempDir ?? '.oracle-schema-tmp');
    await io.mkdir(tempDir, { recursive: true, mode: 0o700 });
    const staging = await io.realpath(tempDir);
    const device = (await io.stat(staging)).dev;
    for (const path of destinations) {
      if ((await io.stat(dirname(path))).dev !== device) {
        throw new OutputError(
          'OUTPUT_PUBLICATION_UNSUPPORTED',
          `Staging and ${path} are on different filesystems. Configure --temp-dir on the destination filesystem.`,
        );
      }
    }
    return { destinations, staging };
  }

  async function stageFile(path: string, contents: Buffer): Promise<void> {
    const handle = await io.open(path, 'wx', 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function syncParentDirectory(path: string): Promise<void> {
    const directory = await io.open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  /**
   * Stage all bytes, then expose artifacts in order and the optional manifest
   * last. Already-published files remain in place after a later failure; retry
   * with new destinations. Cleanup removes only this call's staging directory.
   */
  async function publish(
    artifacts: Artifact[],
    completionPath: string | undefined,
    options: PublicationOptions = {},
  ): Promise<void> {
    const destinationPaths = artifacts.map((artifact) => artifact.path);
    if (completionPath) {
      destinationPaths.push(completionPath);
    }
    const { destinations, staging } = await preflight(
      destinationPaths,
      options,
    );
    const preparedArtifacts: PreparedArtifact[] = artifacts.map(
      (artifact, index) => ({
        ...artifact,
        path: destinations[index],
        contents: Buffer.from(artifact.contents),
      }),
    );
    if (completionPath) {
      const manifest: CompletionManifest = {
        version: 1,
        artifacts: preparedArtifacts.map(({ role, path, contents }) => ({
          role,
          path,
          bytes: contents.byteLength,
          sha256: createHash('sha256').update(contents).digest('hex'),
        })),
      };
      preparedArtifacts.push({
        role: 'completion',
        path: destinations[destinations.length - 1],
        contents: jsonBytes(manifest),
      });
    }
    const publicationDir = await io.mkdtemp(join(staging, 'publication-'));
    const warn = (message: string) => {
      // A diagnostic callback must never change the committed outcome.
      try {
        (options.onWarning ?? console.warn)(message);
      } catch {
        /* diagnostic only */
      }
    };
    let publishedCount = 0;
    try {
      // Stage the entire bundle before exposing any destination.
      for (let index = 0; index < preparedArtifacts.length; index++) {
        await stageFile(
          join(publicationDir, String(index)),
          preparedArtifacts[index].contents,
        );
      }
      for (let index = 0; index < preparedArtifacts.length; index++) {
        const path = preparedArtifacts[index].path;
        try {
          await io.link(join(publicationDir, String(index)), path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          throw new OutputError(
            publicationErrorCode(code),
            `Cannot publish ${path}; atomic hard links are required. Check permissions and --temp-dir.`,
            { cause: error },
          );
        }
        publishedCount++;
        // Visibility is committed at link(). Directory sync is best effort;
        // power-loss durability is not portable across supported platforms.
        try {
          await syncParentDirectory(path);
        } catch {
          warn(
            `OUTPUT_DURABILITY_WARNING: ${path} is published; directory synchronization failed.`,
          );
        }
      }
    } catch (error) {
      if (completionPath && publishedCount > 0) {
        throw new OutputError(
          'OUTPUT_INCOMPLETE',
          `Published ${publishedCount} artifact(s), but the bundle is incomplete. Use new destinations on retry. ${error instanceof Error ? error.message : ''}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      try {
        await io.rm(publicationDir, { recursive: true });
      } catch {
        warn(
          `OUTPUT_CLEANUP_WARNING: ${publishedCount} file(s) published; temporary directory remains: ${publicationDir}`,
        );
      }
    }
  }

  return { preflight, publish };
}

/** Default filesystem-backed operations shared by CLI and orchestration callers. */
export const { preflight: preflightOutputs, publish: publishArtifacts } =
  createArtifactWriter();

/** Encode pipeline JSON as UTF-8 with two-space indentation and a final newline. */
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Publish a single UTF-8 text artifact without replacing an existing path. */
export async function writeNewFile(
  path: string,
  contents: string,
  options?: PublicationOptions,
): Promise<void> {
  await writeNewBuffer(path, Buffer.from(contents, 'utf8'), options);
}

/** Publish exact binary bytes through the same staging and no-overwrite protocol. */
export async function writeNewBuffer(
  path: string,
  contents: Uint8Array,
  options?: PublicationOptions,
): Promise<void> {
  await publishArtifacts(
    [{ role: 'artifact', path, contents }],
    undefined,
    options,
  );
}

/** Serialize and publish JSON; callers remain responsible for schema validation. */
export async function writeJson(
  path: string,
  value: unknown,
  options?: PublicationOptions,
): Promise<void> {
  await writeNewBuffer(path, jsonBytes(value), options);
}
