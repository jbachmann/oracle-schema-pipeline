import { fileURLToPath } from 'node:url';
export const testComposeArgs = [
  'compose',
  '--env-file',
  '/dev/null',
  '-p',
  'oracle-schema-pipeline-test',
  '-f',
  fileURLToPath(new URL('../docker/docker-compose.yml', import.meta.url)),
];
export function rejectDsnOverrides(): void {
  if (
    process.env.ORACLE_SOURCE_DSN !== undefined ||
    process.env.ORACLE_DESTINATION_DSN !== undefined
  )
    throw new Error(
      'Test DSN overrides are forbidden; configure test listener ports instead.',
    );
}
