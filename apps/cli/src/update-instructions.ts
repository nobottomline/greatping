import { detectInstallation } from './installation';

/** Local advice for the running copy, independent of server text or npm availability. */
export function updateHint(formatCommand = (value: string): string => value): string {
  const { updateCommand } = detectInstallation();
  return updateCommand
    ? `Update with ${formatCommand(updateCommand)}`
    : 'Update this installation using its original package manager or source checkout.';
}
