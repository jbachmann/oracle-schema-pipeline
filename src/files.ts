import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

export interface PublicationOptions {
  tempDir?: string;
  onWarning?: (message: string) => void;
}
export interface Artifact {
  role: string;
  path: string;
  contents: Uint8Array;
}
export interface CompletionManifest {
  version: 1;
  artifacts: { role: string; path: string; bytes: number; sha256: string }[];
}
export class OutputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

/** Dependency injection keeps failures at filesystem boundaries testable. */
export function createArtifactWriter(io = fs) {
  async function preflight(paths: string[], options: PublicationOptions = {}) {
    const destinations = await Promise.all(
      paths.map(async (path) =>
        join(
          await io.realpath(dirname(resolve(path))),
          basename(resolve(path)),
        ),
      ),
    );
    // Conservatively reject case/Unicode variants in the same directory, even
    // on case-sensitive disks, so aliases cannot become a partially published set.
    const identities = await Promise.all(
      destinations.map(async (path) => {
        const parent = await io.stat(dirname(path));
        return `${parent.dev}:${parent.ino}:${basename(path).normalize('NFD').toLowerCase()}`;
      }),
    );
    if (new Set(identities).size !== identities.length)
      throw new OutputError(
        'OUTPUT_PATH_CONFLICT',
        'Artifact destinations must be distinct.',
      );
    for (const path of destinations) {
      try {
        await io.lstat(path); // Includes dangling symlinks.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new OutputError('OUTPUT_EXISTS', `Output exists: ${path}`);
    }
    const tempDir = resolve(options.tempDir ?? '.oracle-schema-tmp');
    await io.mkdir(tempDir, { recursive: true, mode: 0o700 });
    const staging = await io.realpath(tempDir);
    const device = (await io.stat(staging)).dev;
    for (const path of destinations) {
      if ((await io.stat(dirname(path))).dev !== device)
        throw new OutputError(
          'OUTPUT_PUBLICATION_UNSUPPORTED',
          `Staging and ${path} are on different filesystems. Configure --temp-dir on the destination filesystem.`,
        );
    }
    return { destinations, staging };
  }

  async function publish(
    artifacts: Artifact[],
    completion: string | undefined,
    options: PublicationOptions = {},
  ): Promise<void> {
    const { destinations, staging } = await preflight(
      [
        ...artifacts.map((artifact) => artifact.path),
        ...(completion ? [completion] : []),
      ],
      options,
    );
    const items: (Omit<Artifact, 'contents'> & { contents: Buffer })[] =
      artifacts.map((artifact, index) => ({
        ...artifact,
        path: destinations[index],
        contents: Buffer.from(artifact.contents),
      }));
    if (completion) {
      const manifest: CompletionManifest = {
        version: 1,
        artifacts: items.map(({ role, path, contents }) => ({
          role,
          path,
          bytes: contents.byteLength,
          sha256: createHash('sha256').update(contents).digest('hex'),
        })),
      };
      items.push({
        role: 'completion',
        path: destinations[destinations.length - 1],
        contents: jsonBytes(manifest),
      });
    }
    const owned = await io.mkdtemp(join(staging, 'publication-'));
    const warn = (message: string) => {
      // A diagnostic callback must never change the committed outcome.
      try {
        (options.onWarning ?? console.warn)(message);
      } catch {
        /* diagnostic only */
      }
    };
    let committed = 0;
    try {
      // Stage the entire bundle before exposing any destination.
      for (let index = 0; index < items.length; index++) {
        const handle = await io.open(join(owned, String(index)), 'wx', 0o600);
        try {
          await handle.writeFile(items[index].contents);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      for (let index = 0; index < items.length; index++) {
        const path = items[index].path;
        try {
          await io.link(join(owned, String(index)), path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          throw new OutputError(
            code === 'EEXIST'
              ? 'OUTPUT_EXISTS'
              : ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(
                    code ?? '',
                  )
                ? 'OUTPUT_PUBLICATION_UNSUPPORTED'
                : 'OUTPUT_PUBLICATION_FAILED',
            `Cannot publish ${path}; atomic hard links are required. Check permissions and --temp-dir.`,
            { cause: error },
          );
        }
        committed++;
        // Visibility is committed at link(). Directory sync is best effort;
        // power-loss durability is not portable across supported platforms.
        try {
          const directory = await io.open(dirname(path), 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } catch {
          warn(
            `OUTPUT_DURABILITY_WARNING: ${path} is published; directory synchronization failed.`,
          );
        }
      }
    } catch (error) {
      if (completion && committed > 0)
        throw new OutputError(
          'OUTPUT_INCOMPLETE',
          `Published ${committed} artifact(s), but the bundle is incomplete. Use new destinations on retry. ${error instanceof Error ? error.message : ''}`,
          { cause: error },
        );
      throw error;
    } finally {
      try {
        await io.rm(owned, { recursive: true });
      } catch {
        warn(
          `OUTPUT_CLEANUP_WARNING: ${committed} file(s) published; temporary directory remains: ${owned}`,
        );
      }
    }
  }
  return { preflight, publish };
}

export const { preflight: preflightOutputs, publish: publishArtifacts } =
  createArtifactWriter();
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}
export async function writeNewFile(
  path: string,
  contents: string,
  options?: PublicationOptions,
): Promise<void> {
  await writeNewBuffer(path, Buffer.from(contents, 'utf8'), options);
}
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
export async function writeJson(
  path: string,
  value: unknown,
  options?: PublicationOptions,
): Promise<void> {
  await writeNewBuffer(path, jsonBytes(value), options);
}
