"""Exercise the built CLI in real PTYs with temporary settings and host fixtures.

The npx fixture records the handoff; it never downloads packages or contacts an
hosted API. Run after building: python3 test/interactive-smoke.py (macOS/Linux).
"""
from pathlib import Path
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

CLI = Path(os.environ.get('GREATPING_TEST_CLI', Path(__file__).resolve().parents[1] / 'dist/index.js'))
NODE = os.environ.get('GREATPING_TEST_NODE') or subprocess.check_output(
    ['node', '-p', 'process.execPath'], text=True).strip()
ACTIVE = []


class Terminal:
    def __init__(self, args, env, rows=24, cols=80):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.process = subprocess.Popen([NODE, str(CLI), *args], stdin=slave,
                                        stdout=subprocess.PIPE, stderr=slave, env=env,
                                        start_new_session=True)
        os.close(slave)
        self.output = ''
        ACTIVE.append(self)

    def wait(self, text):
        until = time.monotonic() + 10
        while time.monotonic() < until:
            if text in self.output or text in re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', self.output):
                return
            if select.select([self.master], [], [], .1)[0]:
                try:
                    self.output += os.read(self.master, 65536).decode(errors='replace')
                except OSError:
                    break
        raise AssertionError(f'Missing {text!r}: {self.output[-1500:]}')

    def send(self, text):
        os.write(self.master, text.encode())

    def press(self, keys, until):
        """Send keys once the previous screen is gone, then wait for the next one."""
        self.output = ''
        self.send(keys)
        self.wait(until)

    def finish(self, expected=0):
        until = time.monotonic() + 10
        while self.process.poll() is None and time.monotonic() < until:
            if select.select([self.master], [], [], .1)[0]:
                try:
                    self.output += os.read(self.master, 65536).decode(errors='replace')
                except OSError:
                    break
        assert self.process.wait(timeout=2) == expected, self.output[-1500:]
        assert self.process.stdout.read() == b'', 'UI and child installer output must stay on stderr'
        self.close()

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        os.close(self.master)
        ACTIVE.remove(self)

    def resize(self, rows, cols):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        os.killpg(self.process.pid, signal.SIGWINCH)


def fixture(root):
    home, bin_dir = root / 'home', root / 'bin'
    for directory in [bin_dir, home / '.claude', home / '.codex']:
        directory.mkdir(parents=True)
    (home / '.claude/settings.json').write_text('{}\n')
    (home / '.codex/config.toml').write_text('')
    (bin_dir / 'node').symlink_to(NODE)
    scripts = {
        'codex': """const fs = require('node:fs'), path = require('node:path');
const file = path.join(process.env.CODEX_HOME, 'config.toml');
const args = process.argv.slice(2);
if (args[0] !== 'mcp' || !['add', 'remove'].includes(args[1])) process.exit(1);
if (args[1] === 'remove') fs.writeFileSync(file, '');
else {
  const parts = args.slice(args.indexOf('--') + 1);
  fs.writeFileSync(file, '[mcp_servers.greatping]\\ncommand = ' + JSON.stringify(parts[0]) + '\\nargs = ' + JSON.stringify(parts.slice(1)) + '\\n');
}
""",
        'npx': """const fs = require('node:fs'), path = require('node:path');
fs.writeFileSync(path.join(process.env.HOME, 'npx-args.json'), JSON.stringify(process.argv.slice(2)));
console.log('Skills installer fixture completed.');
process.exit(Number(process.env.CLI_TEST_NPX_EXIT || '0'));
""",
    }
    for name, source in scripts.items():
        file = bin_dir / name
        file.write_text(f'#!{bin_dir}/node\n{source}')
        file.chmod(0o755)
    return home, {
        'HOME': str(home), 'XDG_CONFIG_HOME': str(home / '.config'),
        'CODEX_HOME': str(home / '.codex'), 'PATH': f'{bin_dir}:/usr/bin:/bin',
        'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8', 'NO_COLOR': '1',
    }


def hashes(home):
    return {p.relative_to(home).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in home.rglob('*') if p.is_file()}


DOWN = '\x1b[B'


def plan(env, args=None, **kwargs):
    """Choose detected agents, then review the plan; explicit targets skip selection."""
    args = args or ['setup', '--no-skill']
    terminal = Terminal(args, env, **kwargs)
    if len(args) < 2 or args[1].startswith('-'):
        terminal.wait('Choose agents')
        terminal.press('\r', 'Review setup')
    else:
        terminal.wait('Review setup')
    return terminal


def customize(env, args=None, scope='claude', **kwargs):
    terminal = plan(env, args, **kwargs)
    index = 2 if scope == 'codex' and not (args and args[1] == 'codex') else 1
    terminal.press(DOWN * index + '\r', ' settings')
    return terminal


def apply(terminal, keys):
    terminal.press(keys + '\r', 'Review setup')
    terminal.output = ''
    terminal.send('\r')


def leave(terminal):
    terminal.press('\x1b', 'Review setup')
    terminal.send('\x1b')


try:
    with tempfile.TemporaryDirectory(prefix='greatping-pty-') as directory:
        home, env = fixture(Path(directory))
        before = hashes(home)
        t = plan(env); t.send('\x1b'); t.wait('Nothing changed'); t.finish()
        assert hashes(home) == before
        t = customize(env); t.press(' \x1b', 'Review setup'); t.send(DOWN * 4 + '\r'); t.finish()
        assert hashes(home) == before
        t = plan(env); t.send('\x03'); t.finish(130)
        assert hashes(home) == before
        t = customize(env); t.send('\x03'); t.finish(130)
        assert hashes(home) == before
        t = plan(env); os.killpg(t.process.pid, signal.SIGTERM); t.finish(143)
        assert hashes(home) == before
        print('PASS Escape, Cancel, Ctrl+C and SIGTERM preserve settings and restore the terminal')

        colors = {key: value for key, value in env.items() if key != 'NO_COLOR'}
        colors['FORCE_COLOR'] = '1'
        t = plan(colors); t.wait('\x1b[32m+\x1b[39m')
        t.send(DOWN + '\r'); t.wait('◼ Questions'); leave(t); t.finish()
        t = plan(colors, ['setup', '--no-skill', '--no-color'])
        assert '\x1b[32m' not in t.output; t.send('\x1b'); t.finish()
        print('PASS Plan and enabled markers are green and --no-color is respected')

        t = customize(env); apply(t, ' ' + DOWN + ' ' + DOWN + DOWN + ' ')
        t.wait('Configuration saved.'); t.finish()
        settings = json.loads((home / '.claude/settings.json').read_text())
        assert 'PreToolUse' not in settings['hooks'] and 'PermissionRequest' not in settings['hooks']
        assert settings['hooks']['Stop'][0]['hooks'][0]['args'][-2:] == ['--alerts', 'tool-input']
        assert 'Claude Code: turn on alerts' in t.output and 'Codex: add GreatPing tools' in t.output
        before = hashes(home)
        t = plan(env); t.wait('No changes needed'); t.send('\r'); t.finish()
        assert 'Tool input, finished turns' in t.output
        assert hashes(home) == before
        t = customize(env); t.wait('◻ Questions'); leave(t); t.finish()
        print('PASS Selected alert categories are installed and repeat setup is idempotent')

        t = customize(env, rows=10, cols=44); t.wait(' settings'); t.resize(24, 80)
        t.send(DOWN); leave(t); t.finish()
        print('PASS Long lists scroll in a short terminal and stay usable after resize')

        claude_skill = home / '.claude/skills/greatping/SKILL.md'
        bundled = (Path(__file__).resolve().parents[3] / 'skills/greatping/SKILL.md').read_text()
        t = plan(env, ['setup']); t.send('\x1b'); t.finish()
        t = customize(env, ['setup']); t.send('\x03'); t.finish(130)
        assert not claude_skill.exists() and not (home / '.agents/skills').exists()
        assert not (home / 'npx-args.json').exists()
        print('PASS The skill is part of the plan and nothing installs before Apply')

        t = plan(env, ['setup', 'claude']); t.wait('· skill'); t.output = ''; t.send('\r')
        t.wait('install the skill in ~/.claude/skills/greatping'); t.finish()
        assert claude_skill.read_text() == bundled
        assert not (home / 'npx-args.json').exists()
        t = plan(env, ['setup', 'claude']); t.wait('No changes needed'); t.send('\r'); t.finish()
        print('PASS Bundled skill installs offline for the chosen agent without npx')

        # Claude Code rows: Questions, Permissions, Tool input, Finished turns, Skill.
        t = customize(env, ['setup', 'claude']); apply(t, DOWN * 4 + ' ')
        t.wait('remove the skill from ~/.claude/skills/greatping'); t.finish()
        assert not claude_skill.parent.exists()
        t = customize(env, ['setup', 'claude']); t.wait('◻ Skill'); leave(t); t.finish()
        print('PASS Turning the skill off removes it and the choice is remembered')

        t = plan(env, ['setup', 'claude']); t.press(DOWN * 3 + '\r', '◆  Other agents'); apply(t, ' ')
        t.wait('Skills installer fixture completed.'); t.finish()
        assert json.loads((home / 'npx-args.json').read_text()) == [
            '--yes', 'skills@1.7.0', 'add', 'nobottomline/greatping', '--skill', 'greatping',
            '--global',
        ]
        assert not claude_skill.exists()
        print('PASS Other agents are handed to npx skills and stdout stays clean')

        t = plan({**env, 'CLI_TEST_NPX_EXIT': '1'}, ['setup', 'claude'])
        t.press(DOWN * 3 + '\r', '◆  Other agents'); apply(t, ' ')
        t.wait('did not complete'); t.finish(1)
        assert json.loads((home / '.claude/settings.json').read_text()).get('hooks')
        assert not (home / '.agents/skills').exists()
        print('PASS Installer failure returns 1 and retains saved hooks')

        # A native plugin is one plan row; its hooks and skill stay with the plugin.
        plugin_home, plugin_env = fixture(home.parent / 'plugin-onboarding')
        package = plugin_home / '.claude/plugins/cache/greatping/greatping/preview'
        shutil.copytree(Path(__file__).resolve().parents[3] / 'plugins/claude/greatping', package)
        inventory = plugin_home / '.claude/plugins/installed_plugins.json'
        inventory.write_text(json.dumps({'version': 2, 'plugins': {'greatping@greatping': [{
            'scope': 'user', 'installPath': str(package), 'version': 'preview'}]}}))
        (plugin_home / '.claude/settings.json').write_text(json.dumps({
            'enabledPlugins': {'greatping@greatping': True}}))
        before = hashes(plugin_home)
        t = plan(plugin_env, ['setup']); t.wait('Claude Code · Questions'); t.send('\x1b'); t.finish()
        assert hashes(plugin_home) == before
        t = plan(plugin_env, ['setup']); t.send('\x03'); t.finish(130)
        assert hashes(plugin_home) == before
        t = customize(plugin_env, ['setup', 'claude'])
        assert '◻ Skill' not in t.output and '◼ Skill' not in t.output and '◼ Questions' not in t.output
        apply(t, ''); t.wait('Configuration saved.'); t.finish()
        assert 'Claude Code: configure the plugin' in t.output
        assert not (plugin_home / 'npx-args.json').exists()
        assert not json.loads((plugin_home / '.claude/settings.json').read_text()).get('hooks')
        print('PASS Native plugin setup supports cancel/Ctrl+C and skips duplicate hooks and skill rows')

        # Deselecting an agent means preserving it, not disabling its integration.
        selected_home, selected_env = fixture(home.parent / 'agent-selection')
        codex_before = (selected_home / '.codex/config.toml').read_bytes()
        t = Terminal(['setup', '--no-skill'], selected_env)
        t.wait('Choose agents'); t.press(DOWN + ' \r', 'Review setup')
        t.wait('Codex · keep current settings'); t.send('\r'); t.finish()
        assert (selected_home / '.codex/config.toml').read_bytes() == codex_before
        assert not (selected_home / '.codex/hooks.json').exists()
        assert json.loads((selected_home / '.claude/settings.json').read_text()).get('hooks')
        print('PASS Explicit agent selection preserves unselected host settings')

        # Native integrations are planned together, and all review rows remain reachable.
        native_home, native_env = fixture(home.parent / 'native-plan')
        (native_home / '.config/opencode').mkdir(parents=True)
        (native_home / '.cursor').mkdir()
        before = hashes(native_home)
        t = Terminal(['setup', '--no-skill'], native_env)
        t.wait('Choose agents'); t.send('\x1b'); t.finish()
        assert hashes(native_home) == before
        t = plan(native_env, rows=10, cols=44)
        t.press(DOWN * 4 + '\r', 'Cursor IDE settings')
        t.resize(24, 80); leave(t); t.finish()
        assert hashes(native_home) == before
        t = plan(native_env); t.send('\x1b'); t.finish()
        assert hashes(native_home) == before
        t = plan(native_env, ['setup', 'opencode', '--no-skill'])
        assert not (native_home / '.config/opencode/plugins/greatping.js').exists()
        t.send('\r'); t.finish()
        assert (native_home / '.config/opencode/plugins/greatping.js').exists()
        before = hashes(native_home)
        t = plan(native_env, ['setup', 'opencode', '--no-skill'])
        t.wait('No changes needed'); t.send('\r'); t.finish()
        assert hashes(native_home) == before
        print('PASS Native setup is deferred until Apply, review rows stay reachable and repeat runs preserve settings')

        # Even response headers must not update caches before Apply on a paired computer.
        paired_home, paired_env = fixture(home.parent / 'paired-preview')
        tests = Path(__file__).resolve().parent
        paired_dir = paired_home / '.config/greatping'
        paired_dir.mkdir(parents=True)
        paired_config = subprocess.check_output([
            NODE, '--experimental-transform-types', '--no-warnings',
            f'--import={tests / "ts-resolve.mjs"}', '--input-type=module', '-e',
            "import { pairedConfig } from './test/fixtures/account.mjs';"
            "import { SERVICE_ORIGIN } from '@greatping/protocol';"
            "process.stdout.write(JSON.stringify(pairedConfig(SERVICE_ORIGIN)))",
        ], cwd=tests.parent, text=True)
        (paired_dir / 'config.json').write_text(paired_config)
        request_log = home.parent / 'setup-read-requests.log'
        paired_env.update({
            'GREATPING_TEST_SETUP_LOG': str(request_log),
            'NODE_OPTIONS': f'--experimental-transform-types --no-warnings --import={tests / "ts-resolve.mjs"} --import={tests / "fixtures/setup-fetch.mjs"}',
        })
        before = hashes(paired_home)
        t = plan(paired_env); t.send('\x1b'); t.finish()
        assert hashes(paired_home) == before
        assert request_log.read_text().splitlines() == ['GET /v1/machine/me']
        assert not (paired_dir / 'alerts.json').exists()
        print('PASS Paired preview and Cancel preserve files and make only one read request, even with settings headers')

        # A configured plugin can still conflict with direct hooks; never call that ready.
        conflict_home, conflict_env = fixture(home.parent / 'plugin-conflict')
        subprocess.run([NODE, str(CLI), 'setup', 'claude', '--yes', '--no-skill'],
                       env=conflict_env, capture_output=True, check=True, timeout=10)
        conflict_package = conflict_home / '.claude/plugins/cache/greatping/greatping/preview'
        shutil.copytree(Path(__file__).resolve().parents[3] / 'plugins/claude/greatping', conflict_package)
        inventory = conflict_home / '.claude/plugins/installed_plugins.json'
        inventory.write_text(json.dumps({'version': 2, 'plugins': {'greatping@greatping': [{
            'scope': 'user', 'installPath': str(conflict_package)}]}}))
        conflict_settings = json.loads((conflict_home / '.claude/settings.json').read_text())
        conflict_settings['enabledPlugins'] = {'greatping@greatping': True}
        (conflict_home / '.claude/settings.json').write_text(json.dumps(conflict_settings))
        before = hashes(conflict_home)
        for _ in range(2):
            t = plan(conflict_env, ['setup', 'claude', '--no-skill'])
            t.wait('needs attention'); t.press(DOWN + '\r', '--migrate')
            assert 'No changes needed' not in t.output
            t.send('\x1b'); t.finish()
            assert hashes(conflict_home) == before
        print('PASS Plugin conflicts are shown before Apply and remain visible on repeated setup')

        # Public commands cannot select another API host. Help must not advertise it.
        for command in ['login', 'logout', 'status', 'ask', 'notify', 'pause', 'resume', 'doctor']:
            result = subprocess.run([NODE, str(CLI), command, '--server', 'https://other.example'],
                                    env=env, capture_output=True, timeout=5)
            assert result.returncode == 1, command
            assert b"Unknown option '--server'" in result.stderr, result.stderr
        for command in [[], ['login'], ['doctor']]:
            result = subprocess.run([NODE, str(CLI), *command, '--help'],
                                    env=env, capture_output=True, timeout=5)
            assert result.returncode == 0
            assert b'--server' not in result.stderr and b'GREATPING_API_URL' not in result.stderr
        print('PASS Public commands reject server overrides and help omits server configuration')

        # Pairing is already saved when setup is interrupted. Propagate its code.
        onboarding_home, onboarding_env = fixture(home.parent / 'onboarding')
        config = onboarding_home / '.config/greatping/config.json'
        try:
            tests = Path(__file__).resolve().parent
            pairing_fixture = os.environ.get('GREATPING_TEST_PAIRING_FIXTURE',
                                             str(tests / 'fixtures/pairing-fetch.mjs'))
            onboarding_env['NODE_OPTIONS'] = (
                f'--experimental-transform-types --no-warnings '
                f'--import={tests / "ts-resolve.mjs"} '
                f'--import={pairing_fixture}')
            t = Terminal(['login', '--name', 'PTY Mac'], onboarding_env)
            t.wait('Choose agents'); t.send('\x03'); t.finish(130)
            assert json.loads(config.read_text())['machineId'] == 'pty-machine'
        finally:
            config.unlink(missing_ok=True)
        print('PASS Pairing enters the setup plan directly; Ctrl+C propagates 130 and retains pairing')

        # After pairing with already configured hosts, a stale owned skill gets
        # its own update offer. Declining or interrupting preserves it.
        update_home, update_env = fixture(home.parent / 'skill-update-login')
        subprocess.run([NODE, str(CLI), 'setup', '--yes', '--no-skill'],
                       env=update_env, capture_output=True, check=True, timeout=10)
        tests = Path(__file__).resolve().parent
        update_env['NODE_OPTIONS'] = (
            f'--experimental-transform-types --no-warnings '
            f'--import={tests / "ts-resolve.mjs"} '
            f'--import={os.environ.get("GREATPING_TEST_PAIRING_FIXTURE", str(tests / "fixtures/pairing-fetch.mjs"))}')
        old_content = '---\nname: greatping\ndescription: older owned copy\n---\n'
        installer = (
            f'import {{ installSkill }} from {json.dumps((tests.parent / "src/integrations/skill.ts").as_uri())}; '
            f'installSkill("claude", {json.dumps(old_content)});')
        subprocess.run([NODE, '--input-type=module', '-e', installer],
                       env=update_env, capture_output=True, check=True, timeout=10)
        update_file = update_home / '.claude/skills/greatping/SKILL.md'
        update_config = update_home / '.config/greatping/config.json'
        t = Terminal(['login', '--name', 'Skill QA Mac'], update_env)
        t.wait('is out of date. Update it?'); t.send('n\r'); t.finish()
        assert update_file.read_text() == old_content and update_config.exists()
        update_config.unlink()
        t = Terminal(['login', '--name', 'Skill QA Mac'], update_env)
        t.wait('is out of date. Update it?'); t.send('\x03'); t.finish(130)
        assert update_file.read_text() == old_content and update_config.exists()
        update_config.unlink()
        result = subprocess.run([NODE, str(CLI), 'login', '--name', 'Skill QA Mac'],
                                env=update_env, capture_output=True, timeout=10)
        assert result.returncode == 0, result.stderr
        assert b'greatping doctor --fix' in result.stderr
        assert update_file.read_text() == old_content
        update_config.unlink()
        t = Terminal(['login', '--name', 'Skill QA Mac'], update_env)
        t.wait('is out of date. Update it?'); t.send('\r')
        t.wait('Skill updated for Claude Code'); t.finish()
        assert update_file.read_text() == bundled
        print('PASS Login skill updates require consent, preserve pairing on interruption and stay read-only non-interactively')

        # Turning alerts/tools off must preserve skills handled separately.
        skill = home / '.agents/skills/greatping/SKILL.md'
        skill.parent.mkdir(parents=True); skill.write_text('---\nname: greatping\n---\n')
        # Each agent has its own settings screen; changing one cannot clear another.
        t = customize(env, ['setup', 'claude', '--no-skill']); apply(t, DOWN * 2 + ' ' + DOWN + ' ')
        t.finish()
        t = customize(env, ['setup', 'codex', '--no-skill'], scope='codex'); apply(t, ' ' + DOWN + ' ')
        t.wait('Codex: remove GreatPing tools'); t.finish()
        assert not json.loads((home / '.claude/settings.json').read_text()).get('hooks')
        assert skill.exists()
        t = customize(env, ['setup', 'claude', '--no-skill'])
        assert not any(f'◼ {label}' in t.output for label in ['Questions', 'Permissions', 'Tool input', 'Finished turns'])
        leave(t); t.finish()
        t = plan(env); t.wait('No changes needed'); t.send('\r'); t.finish()
        print('PASS All-off persists while existing skills remain intact')

        prefs = home / '.config/greatping/setup-options.json'
        prefs.write_text('{"claude":{"alerts":null,"finished":"bad"},"codex":null}')
        t = plan(env); t.send('\x1b'); t.finish()
        print('PASS Corrupt saved preferences do not crash the picker')
        before = hashes(home)
        t = Terminal(['uninstall', '--dry-run'], env)
        t.wait('Dry run:'); t.finish()
        assert hashes(home) == before
        print('PASS Uninstall dry-run leaves settings unchanged')

        t = Terminal(['uninstall'], env)
        t.wait('Remove these GreatPing components?'); t.send('\r'); t.finish()
        assert hashes(home) == before
        print('PASS Uninstall defaults to declining removal')

        t = Terminal(['uninstall'], env)
        t.wait('Remove these GreatPing components?'); t.send('\x03'); t.finish(130)
        assert hashes(home) == before
        print('PASS Uninstall Ctrl+C leaves settings unchanged')

finally:
    for terminal in list(ACTIVE):
        terminal.close()
