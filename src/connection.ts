/**
 * Shared connection-option validation for the extraction CLI and clone setup.
 * Converts a raw DSN or a TNS file/alias pair into Oracle driver settings without
 * opening a database connection or handling credentials.
 */
import { access, constants, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';

export interface ConnectionOptions {
  dsn?: string;
  tnsnames?: string;
  tnsAlias?: string;
}

export type ResolvedConnection = {
  connectString: string;
  configDir?: string;
};

/**
 * Pass through a DSN unchanged, or validate a local tnsnames.ora file and alias.
 * The caller supplies alias discovery so this module stays independent of the
 * Oracle driver and can be tested offline. Invalid options, inaccessible files,
 * and alias lookup failures produce errors suitable for CLI diagnostics.
 */
export async function resolveConnectionOptions(
  options: ConnectionOptions,
  listAliases: (configDir: string) => Promise<string[]>,
): Promise<ResolvedConnection> {
  const { dsn, tnsnames, tnsAlias } = options;
  if (dsn && (tnsnames || tnsAlias)) {
    throw new Error(
      '--dsn is mutually exclusive with --tnsnames and --tns-alias.',
    );
  }
  if (dsn) {
    return { connectString: dsn };
  }
  if (!tnsnames && !tnsAlias) {
    throw new Error('Missing --dsn or --tnsnames/--tns-alias. See --help.');
  }
  if (!tnsnames) {
    throw new Error('Missing --tnsnames for --tns-alias.');
  }
  if (!tnsAlias) {
    throw new Error('Missing --tns-alias for --tnsnames.');
  }

  if (!isAbsolute(tnsnames)) {
    throw new Error(`TNS path must be absolute: ${tnsnames}.`);
  }
  if (basename(tnsnames) !== 'tnsnames.ora') {
    throw new Error(`TNS file must be named tnsnames.ora: ${tnsnames}.`);
  }
  // Check the file before alias discovery; the driver still handles read failures
  // if the file changes after this preflight.
  try {
    const details = await stat(tnsnames);
    if (!details.isFile()) {
      throw new Error('not a regular file');
    }
    await access(tnsnames, constants.R_OK);
  } catch {
    throw new Error(
      `TNS file is missing, unreadable, or not a regular file: ${tnsnames}.`,
    );
  }

  // The driver takes the containing directory as configDir, not the file path.
  const configDir = dirname(tnsnames);
  let aliases: string[];
  try {
    aliases = await listAliases(configDir);
  } catch {
    throw new Error(`Unable to read TNS aliases from ${tnsnames}.`);
  }
  // Match aliases without case sensitivity, but preserve the caller's spelling.
  const normalizedAlias = tnsAlias.toUpperCase();
  if (!aliases.some((alias) => alias.toUpperCase() === normalizedAlias)) {
    throw new Error(`TNS alias ${tnsAlias} not found in ${tnsnames}.`);
  }
  return { connectString: tnsAlias, configDir };
}
