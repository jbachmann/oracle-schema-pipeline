import { access, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';

export interface ConnectionOptions { dsn?: string; tnsnames?: string; tnsAlias?: string; }
export type ResolvedConnection = { connectString: string; configDir?: string };

export async function resolveConnectionOptions(
  options: ConnectionOptions,
  listAliases: (configDir: string) => Promise<string[]>,
): Promise<ResolvedConnection> {
  const { dsn, tnsnames, tnsAlias } = options;
  if (dsn && (tnsnames || tnsAlias)) throw new Error('--dsn is mutually exclusive with --tnsnames and --tns-alias.');
  if (dsn) return { connectString: dsn };
  if (!tnsnames && !tnsAlias) throw new Error('Missing --dsn or --tnsnames/--tns-alias. See --help.');
  if (!tnsnames) throw new Error('Missing --tnsnames for --tns-alias.');
  if (!tnsAlias) throw new Error('Missing --tns-alias for --tnsnames.');
  if (!isAbsolute(tnsnames)) throw new Error(`TNS path must be absolute: ${tnsnames}.`);
  if (basename(tnsnames) !== 'tnsnames.ora') throw new Error(`TNS file must be named tnsnames.ora: ${tnsnames}.`);
  try {
    const details = await stat(tnsnames);
    if (!details.isFile()) throw new Error('not a regular file');
    await access(tnsnames);
  } catch {
    throw new Error(`TNS file is missing, unreadable, or not a regular file: ${tnsnames}.`);
  }
  const configDir = dirname(tnsnames);
  let aliases: string[];
  try { aliases = await listAliases(configDir); }
  catch { throw new Error(`Unable to read TNS aliases from ${tnsnames}.`); }
  if (!aliases.some(alias => alias.toUpperCase() === tnsAlias.toUpperCase())) {
    throw new Error(`TNS alias ${tnsAlias} not found in ${tnsnames}.`);
  }
  return { connectString: tnsAlias, configDir };
}
