// Codex runs command strings through cmd.exe on Windows. Keep paths and argv
// out of that parser entirely. Windows PowerShell 5.1 is part of Windows;
// ProcessStartInfo avoids its legacy native-argument and pipeline conversion.
const prefix = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ';

function argument(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}
const literal = (value) => `'${value.replace(/'/g, "''")}'`;
function script(parts) {
  const metadata = Buffer.from(JSON.stringify(parts)).toString('base64');
  return [
    `# greatping-argv:${metadata}`,
    "$ErrorActionPreference = 'Stop'",
    '$s = New-Object System.Diagnostics.ProcessStartInfo',
    '$s.UseShellExecute = $false',
    `$s.FileName = ${literal(parts[0])}`,
    `$s.Arguments = ${literal(parts.slice(1).map(argument).join(' '))}`,
    '$p = [System.Diagnostics.Process]::Start($s)',
    '$p.WaitForExit()',
    'exit $p.ExitCode',
  ].join('\n');
}

export function windowsShellCommand(parts) {
  if (!parts.length || !parts[0] || parts.some((part) => part.includes('\0')))
    throw new Error('Invalid Windows hook invocation.');
  const command = prefix + Buffer.from(script(parts), 'utf16le').toString('base64');
  if (command.length > 8000) throw new Error('The Windows hook invocation is too long.');
  return command;
}

// Ownership inspection must recognize only the exact launcher we generate,
// never a comment attached to an arbitrary command. Legacy strings use the
// existing parser, so upgrades can still inspect and remove old hooks.
export function parseWindowsShellCommand(command) {
  if (!command.startsWith(prefix)) return null;
  try {
    const decoded = Buffer.from(command.slice(prefix.length), 'base64').toString('utf16le');
    const metadata = /^# greatping-argv:([A-Za-z0-9+/=]+)\n/.exec(decoded)?.[1];
    if (!metadata) return [];
    const parts = JSON.parse(Buffer.from(metadata, 'base64').toString('utf8'));
    if (!Array.isArray(parts) || !parts.every((part) => typeof part === 'string')) return [];
    return windowsShellCommand(parts) === command ? parts : [];
  } catch {
    return [];
  }
}
