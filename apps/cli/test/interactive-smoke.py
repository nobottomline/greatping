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
            if text in self.output:
                return
            if select.select([self.master], [], [], .1)[0]:
                try:
                    self.output += os.read(self.master, 65536).decode(errors='replace')
                except OSError:
                    break
        raise AssertionError(f'Missing {text!r}: {self.output[-1500:]}')

    def send(self, text):
        os.write(self.master, text.encode())

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


def picker(env, **kwargs):
    terminal = Terminal(['setup', '--no-skill'], env, **kwargs)
    terminal.wait('Enter Toggle')
    return terminal


try:
    with tempfile.TemporaryDirectory(prefix='greatping-pty-') as directory:
        home, env = fixture(Path(directory))
        before = hashes(home)
        t = picker(env); t.send('\r\x1b'); t.finish()
        assert hashes(home) == before
        t = picker(env); t.send('\x03'); t.finish(130)
        assert hashes(home) == before
        t = picker(env); os.killpg(t.process.pid, signal.SIGTERM); t.finish(143)
        assert hashes(home) == before
        print('PASS Escape, Ctrl+C and SIGTERM preserve settings and restore the terminal')

        colors = {key: value for key, value in env.items() if key != 'NO_COLOR'}
        colors['FORCE_COLOR'] = '1'
        t = picker(colors); t.wait('\x1b[32m●\x1b[39m'); t.send('\x1b'); t.finish()
        t = Terminal(['setup', '--no-skill', '--no-color'], colors)
        t.wait('Enter Toggle'); assert '\x1b[32m' not in t.output; t.send('\x1b'); t.finish()
        print('PASS Enabled markers are green and --no-color is respected')

        t = picker(env); t.send('\r\x1b[B\r\x1b[B\x1b[B\r\x1b[F\r'); t.finish()
        settings = json.loads((home / '.claude/settings.json').read_text())
        assert 'PreToolUse' not in settings['hooks'] and 'PermissionRequest' not in settings['hooks']
        assert settings['hooks']['Stop'][0]['hooks'][0]['args'][-2:] == ['--alerts', 'tool-input']
        before = hashes(home)
        t = picker(env); t.wait('○ Questions'); t.send('\x1b[F\r'); t.finish()
        assert hashes(home) == before
        print('PASS Selected alert categories are installed and repeat setup is idempotent')

        t = picker(env, rows=12, cols=44); t.resize(24, 80); t.send('\x1b[B\x1b'); t.finish()
        print('PASS Compact picker stays usable after resize')

        t = Terminal(['setup'], env); t.wait('Enter Toggle'); t.send('\x1b[F\r')
        t.wait('Enter Select'); t.send('\x1b[B\r'); t.finish()
        assert not (home / 'npx-args.json').exists()
        t = Terminal(['setup'], env); t.wait('Enter Toggle'); t.send('\x1b[F\r')
        t.wait('Enter Select'); t.send('\x03'); t.finish(130)
        print('PASS Separate skill question supports skip and interruption')

        t = Terminal(['setup', 'claude'], env); t.wait('Enter Toggle'); t.send('\x1b[F\r')
        t.wait('Enter Select'); t.send('\r'); t.finish()
        assert json.loads((home / 'npx-args.json').read_text()) == [
            '--yes', 'skills@1.7.0', 'add', 'nobottomline/greatping', '--skill', 'greatping',
            '--global', '--agent', 'claude-code',
        ]
        print('PASS Skill setup hands the requested agent to npx and keeps stdout clean')

        t = Terminal(['setup'], {**env, 'CLI_TEST_NPX_EXIT': '1'})
        t.wait('Enter Toggle'); t.send('\x1b[F\r'); t.wait('Enter Select'); t.send('\r')
        t.wait('Your alert settings are saved.'); t.finish(1)
        assert json.loads((home / '.claude/settings.json').read_text()).get('hooks')
        print('PASS Installer failure returns 1 and retains saved hooks')

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
            onboarding_env['NODE_OPTIONS'] = (
                f'--experimental-transform-types --no-warnings '
                f'--import={tests / "ts-resolve.mjs"} '
                f'--import={tests / "fixtures/pairing-fetch.mjs"}')
            t = Terminal(['login', '--name', 'PTY Mac'], onboarding_env)
            t.wait('Enter Toggle'); t.send('\x03'); t.finish(130)
            assert json.loads(config.read_text())['machineId'] == 'pty-machine'
        finally:
            config.unlink(missing_ok=True)
        print('PASS Pairing enters the picker directly; Ctrl+C propagates 130 and retains pairing')

        # Turning alerts/tools off must preserve skills handled separately.
        skill = home / '.agents/skills/greatping/SKILL.md'
        skill.parent.mkdir(parents=True); skill.write_text('---\nname: greatping\n---\n')
        t = picker(env)
        for index in range(6):
            if index >= 2: t.send('\r')
            t.send('\x1b[B')
        t.send('\r'); t.finish()
        assert not json.loads((home / '.claude/settings.json').read_text()).get('hooks')
        assert skill.exists()
        t = picker(env)
        assert not any(f'● {label}' in t.output for label in ['Questions', 'Permissions', 'Tool input', 'Finished responses', 'Agent tools'])
        t.send('\x1b'); t.finish()
        print('PASS All-off persists while existing skills remain intact')

        prefs = home / '.config/greatping/setup-options.json'
        prefs.write_text('{"claude":{"alerts":null,"finished":"bad"},"codex":null}')
        t = picker(env); t.send('\x1b'); t.finish()
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
