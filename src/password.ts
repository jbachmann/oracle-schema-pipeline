/** A small hidden TTY prompt; credentials are never accepted as CLI arguments. */
export async function readPassword(
  writePrompt: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): Promise<string> {
  if (process.env.ORACLE_PASSWORD) return process.env.ORACLE_PASSWORD;
  const input = process.stdin;
  if (!input.isTTY)
    throw new Error(
      'Set ORACLE_PASSWORD when running without an interactive terminal',
    );
  writePrompt('Source password: ');
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolvePassword, reject) => {
    let value = '';
    const cleanup = (): void => {
      input.off('data', onData);
      input.off('error', onError);
      input.setRawMode(wasRaw);
      input.pause();
      writePrompt('\n');
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (data: string): void => {
      for (const character of data) {
        if (character === '\u0003' || character === '\u0004') {
          cleanup();
          reject(new Error('Password entry cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolvePassword(value);
          return;
        }
        if (character === '\u007f' || character === '\b')
          value = [...value].slice(0, -1).join('');
        else if (character >= ' ') value += character;
      }
    };
    input.on('data', onData);
    input.on('error', onError);
  });
}
