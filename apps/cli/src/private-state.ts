import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const protectedDirectories = new Map<string, string>();
const protect = `
$ErrorActionPreference = 'Stop'
$directory = $env:GREATPING_PRIVATE_DIRECTORY
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $directory -AclObject $acl
foreach ($name in @('config.json', 'alerts.json')) {
  $file = Join-Path $directory $name
  if (Test-Path -LiteralPath $file) {
    $item = Get-Item -LiteralPath $file -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked private state is unsupported' }
    $fileAcl = New-Object System.Security.AccessControl.FileSecurity
    $fileAcl.SetAccessRuleProtection($true, $false)
    $fileAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $file -AclObject $fileAcl
  }
}
`;

/** Secure the containing directory before publishing any keys or temporary
 * files. Existing credentials also need their own ACL: Windows traversal
 * privileges can bypass a directory's ACL when a file's full path is known.
 * No secret is passed to PowerShell, and failures prevent reading/writing it.
 */
export function ensurePrivateStateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(directory, 0o700);
    return;
  }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('The private GreatPing directory must be a real directory.');
  const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  if (protectedDirectories.get(directory) === identity) return;
  const powershell = join(
    process.env.SystemRoot || 'C:/Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const result = spawnSync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(protect, 'utf16le').toString('base64'),
    ],
    {
      env: { ...process.env, GREATPING_PRIVATE_DIRECTORY: directory },
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10000,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      'Could not secure the private GreatPing directory. Check Windows permissions and PowerShell availability.',
    );
  protectedDirectories.set(directory, identity);
}
