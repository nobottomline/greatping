import { spawn } from 'node:child_process';
import { loadConfig } from '../config';
import { reportMachineWithProgress } from '../report';
import { pickSetup } from '../setup-picker';
import { command, muted, print, ui } from '../ui';
import { recordManagedSkill, SKILLS_RUNNER } from './managed-skills';
import type { HostId } from './state';

/** Hand skill selection and installation to the upstream skills CLI. */
export async function setupSkills(only: HostId | null, hosts?: HostId[]): Promise<number> {
  ui.heading('Agent skill');
  print('  Set up the GreatPing skill for your agents?');
  print(`  ${muted('Use “ping me” and “pause alerts” in your agent chats.')}`);
  print();
  const choice = await pickSetup(
    [
      {
        id: 'install',
        group: '',
        label: 'Set up with npx skills',
        hint: 'Choose agents and installation options in the skills installer.',
        selected: true,
      },
      {
        id: 'skip',
        group: '',
        label: 'Skip for now',
        hint: 'Keep your current skills. You can set this up later.',
        selected: false,
      },
    ],
    'select',
  );
  if (!choice?.has('install')) {
    ui.info('Skill setup skipped. Your alert settings are saved.');
    return Number(process.exitCode ?? 0);
  }
  const args = [
    '--yes',
    SKILLS_RUNNER,
    'add',
    'nobottomline/greatping',
    '--skill',
    'greatping',
    '--global',
  ];
  for (const id of hosts ?? (only ? [only] : []))
    args.push('--agent', id === 'claude' ? 'claude-code' : id);
  ui.next(command(`npx ${args.slice(1).join(' ')}`));
  print();
  // --yes approves fetching the npm runner; skills keeps its own prompts.
  const code = await new Promise<number>((resolve) => {
    const child = spawn('npx', args, {
      // The arguments above are fixed or parsed HostIds; Windows runs npx.cmd.
      stdio: ['inherit', process.stderr, process.stderr],
      shell: process.platform === 'win32',
    });
    const forwardInt = () => child.kill('SIGINT');
    const forwardTerm = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', forwardInt);
      process.off('SIGTERM', forwardTerm);
    };
    process.on('SIGINT', forwardInt);
    process.on('SIGTERM', forwardTerm);
    child.once('error', (error) => {
      cleanup();
      ui.error('Could not start npx skills.', error.message);
      resolve(1);
    });
    child.once('exit', (status, signal) => {
      cleanup();
      resolve(status ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
  if (code !== 0) {
    ui.warn('Skill setup did not complete. Your alert settings are saved.');
    ui.next(
      `Try again with ${command('npx skills add nobottomline/greatping --skill greatping --global')}.`,
    );
  }
  // Reconcile even after a partial install or cancellation.
  recordManagedSkill();
  await reportMachineWithProgress(loadConfig());
  return code;
}
