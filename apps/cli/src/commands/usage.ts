/** Invalid input or state; printed with a hint and the command's usage line. */
export class UsageError extends Error {
  constructor(
    readonly command: string | null,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}
