/** Read ORACLE_PASSWORD or prompt for hidden input on an interactive terminal. */
export async function readPassword(
  writePrompt: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): Promise<string> {
  if (process.env.ORACLE_PASSWORD) return process.env.ORACLE_PASSWORD;

  const input = process.stdin;
  if (!input.isTTY) {
    throw new Error(
      'Set ORACLE_PASSWORD when running without an interactive terminal',
    );
  }

  writePrompt('Source password: ');
  const wasRawMode = input.isRaw;
  const wasFlowing = input.readableFlowing === true;

  return new Promise((resolve, reject) => {
    let password = '';
    let finished = false;

    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      input.off('data', onData);
      input.off('error', onError);
      input.off('end', onEnd);

      // Attempt every cleanup step even if terminal restoration fails.
      for (const restore of [
        () => input.setRawMode(wasRawMode),
        () => (wasFlowing ? input.resume() : input.pause()),
        () => writePrompt('\n'),
      ]) {
        try {
          restore();
        } catch (cleanupError) {
          error ??= cleanupError;
        }
      }

      if (error !== undefined) reject(error);
      else resolve(password);
    };
    const onError = (error: Error): void => {
      finish(error);
    };
    const onEnd = (): void => {
      finish(new Error('Password entry cancelled'));
    };
    const onData = (data: string): void => {
      for (const character of data) {
        // Ctrl+C and Ctrl+D cancel entry in raw mode.
        if (character === '\u0003' || character === '\u0004') {
          onEnd();
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          // Remove one code point without splitting a surrogate pair.
          password = [...password].slice(0, -1).join('');
        } else if (character >= ' ') {
          password += character;
        }
      }
    };

    input.on('data', onData);
    input.on('error', onError);
    input.on('end', onEnd);

    try {
      input.setRawMode(true);
      input.setEncoding('utf8');
      input.resume();
    } catch (error) {
      finish(error);
    }
  });
}
