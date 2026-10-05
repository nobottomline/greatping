import process from 'node:process';
import { spinner } from './ui';

/** An interrupted CLI operation is distinct from a service failure. */
export class CommandInterrupted extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly silent: boolean,
  ) {
    super(message);
  }
}

/** Bounded operations supply their own timeout; this owns only terminal activity and cancellation. */
export async function withProgress<T>(
  label: string,
  work: (signal: AbortSignal, update: (label: string) => void) => Promise<T>,
  options: { json?: boolean; interrupted?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  let exitCode = 0;
  const interrupt = () => {
    exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    exitCode = 143;
    controller.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const progress = options.json ? undefined : spinner(label);
  try {
    const result = await work(controller.signal, (next) => progress?.update(next));
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (exitCode)
      throw new CommandInterrupted(
        options.interrupted ?? 'Operation interrupted.',
        exitCode,
        options.json === true,
      );
    throw error;
  } finally {
    progress?.stop();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
