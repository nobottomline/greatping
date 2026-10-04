"""Check final screen contents and update notices in real PTYs, without hosted requests."""
from pathlib import Path
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get('GREATPING_TEST_CLI', ROOT / 'dist/index.js'))
NODE = os.environ.get('GREATPING_TEST_NODE') or subprocess.check_output(
    ['node', '-p', 'process.execPath'], text=True).strip()
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
ACTIVE = []


class Terminal:
    def __init__(self, args, env, cols=100, split=False):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, cols, 0, 0))
        self.process = subprocess.Popen([NODE, str(CLI), *args], stdin=slave,
            stdout=subprocess.PIPE if split else slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)
        self.output = ''
        self.cols = cols
        ACTIVE.append(self)

    def read(self):
        if select.select([self.master], [], [], .05)[0]:
            try:
                data = os.read(self.master, 65536)
                if not data:
                    return False
                self.output += data.decode(errors='replace')
                return True
            except OSError:
                pass
        return False

    def wait(self, text):
        deadline = time.monotonic() + 5
        while text not in self.output and time.monotonic() < deadline:
            self.read()
        assert text in self.output, self.output

    def finish(self, expected=0):
        deadline = time.monotonic() + 8
        while self.process.poll() is None and time.monotonic() < deadline:
            self.read()
        assert self.process.wait(timeout=1) == expected, self.output
        while self.read():
            pass
        result = self.process.stdout.read().decode() if self.process.stdout else ''
        os.close(self.master)
        ACTIVE.remove(self)
        return result

    def resize(self, cols):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, cols, 0, 0))
        os.killpg(self.process.pid, signal.SIGWINCH)


def screen(raw, cols):
    """Interpret the VT operations used by the CLI instead of searching raw frames.

    In particular CR + erase-line must remove the waiting label before final text.
    """
    rows = [[]]
    x = y = 0
    for part in re.findall(r'\x1b\[[0-9;?]*[A-Za-z]|[^\x1b]', raw):
        if part.startswith('\x1b['):
            if part.endswith('K'):
                if part == '\x1b[2K': rows[y] = []
                else: rows[y] = rows[y][:x]
            elif part.endswith('A'):
                y = max(0, y - int(part[2:-1] or '1'))
            continue
        if part == '\r': x = 0; continue
        if part == '\n': y += 1; x = 0
        else:
            if x >= cols: y += 1; x = 0
            while len(rows) <= y: rows.append([])
            while len(rows[y]) <= x: rows[y].append(' ')
            rows[y][x] = part
            x += 1
        while len(rows) <= y: rows.append([])
    return '\n'.join(''.join(row).rstrip() for row in rows).strip()


try:
    with tempfile.TemporaryDirectory(prefix='greatping-terminal-') as temporary:
        root = Path(temporary)
        config = root / '.config/greatping'
        config.mkdir(parents=True)
        (config / 'config.json').write_text(json.dumps({
            'apiUrl': 'https://greatping-api-dev.ueldo343.workers.dev',
            'machineId': 'terminal-machine', 'machineToken': 'fixture-token'}))
        env = {'HOME': temporary, 'XDG_CONFIG_HOME': str(root / '.config'),
            'PATH': os.environ['PATH'], 'TERM': 'xterm-256color', 'NO_COLOR': '1',
            'NODE_OPTIONS': f'--import={ROOT / "test/fixtures/terminal-fetch.mjs"}',
            'NO_UPDATE_NOTIFIER': '1'}

        for cols in [100, 32, 8]:
            t = Terminal(['ask', 'Deploy?'], env, cols=cols)
            t.finish()
            final = screen(t.output, cols)
            assert 'Waiting' not in final, final
            assert re.sub(r'\s', '', 'Answered') in re.sub(r'\s', '', final), final
            assert re.sub(r'\s', '', 'Ship it') in re.sub(r'\s', '', final), final
            assert t.output.rfind('\x1b[2K') < t.output.index('Answered'), t.output
            assert '\x1b[?25h' in t.output, 'Cursor not restored'
        print('PASS Answer replaces waiting on wide and narrow terminal screens')

        for mode, code, text in [('expired', 2, 'expired'), ('resolved', 2, 'resolved'),
                                 ('cancelled', 2, 'cancelled'), ('error', 1, 'pair again')]:
            t = Terminal(['ask', 'Deploy?'], {**env, 'GREATPING_TEST_MODE': mode})
            t.finish(code)
            final = screen(t.output, t.cols)
            assert 'Waiting' not in final and text in final, final
            assert '\x1b[?25h' in t.output
        for sig, code in [(signal.SIGINT, 130), (signal.SIGTERM, 143)]:
            t = Terminal(['ask', 'Deploy?'], env)
            t.wait('Waiting')
            os.killpg(t.process.pid, sig)
            t.finish(code)
            final = screen(t.output, t.cols)
            assert 'Waiting' not in final and 'Question withdrawn' in final, final
        print('PASS Expiry, resolution, errors and signals clear waiting and restore cursor')

        t = Terminal(['ask', 'Deploy?'], env)
        t.wait('Waiting'); t.resize(32); t.finish()
        assert t.output.rfind('\x1b[2K') < t.output.index('Answered')
        t = Terminal(['ask', 'Deploy?'], env, split=True)
        assert t.finish() == 'Ship it\n'
        t = Terminal(['ask', 'Deploy?', '--json'], env, split=True)
        assert json.loads(t.finish())['answer'] == {'text': 'Ship it'}
        assert t.output == '', t.output
        print('PASS Resize cleanup, piped answers and JSON preserve the output contract')

        for cols in [100, 32, 8]:
            t = Terminal(['notify', 'Build complete'], env, cols=cols)
            t.wait('Sending' if cols > 8 else '⠋')
            assert t.process.poll() is None, 'Notice completed before progress was visible'
            t.finish()
            final = screen(t.output, cols)
            assert 'Sending' not in final, final
            assert 'GreatPingacceptedthenotice.' in re.sub(r'\s', '', final), final
            assert t.output.rfind('\x1b[2K') < t.output.index('GreatPing accepted'), t.output
            assert '\x1b[?25h' in t.output, 'Cursor not restored'
        for mode, code, text in [('paused', 0, 'paused'), ('error', 1, 'pair again'),
                                 ('network', 1, 'Check your internet connection')]:
            t = Terminal(['notify', 'Build complete'], {**env, 'GREATPING_TEST_MODE': mode})
            t.wait('Sending'); t.finish(code)
            final = screen(t.output, t.cols)
            assert 'Sending' not in final and text in final, final
            assert 'GreatPing accepted' not in final, final
            assert '\x1b[?25h' in t.output
        print('PASS Notify shows immediate progress and replaces it on acceptance, pause and errors')

        for sig, code in [(signal.SIGINT, 130), (signal.SIGTERM, 143)]:
            t = Terminal(['notify', 'Build complete'], {**env, 'GREATPING_TEST_MODE': 'hang'})
            t.wait('Sending'); os.killpg(t.process.pid, sig); t.finish(code)
            final = screen(t.output, t.cols)
            assert 'Sending notice' not in final and 'may have accepted' in final, final
            assert '\x1b[?25h' in t.output
        t = Terminal(['notify', 'Build complete'], env)
        t.wait('Sending'); t.resize(32); t.finish()
        assert t.output.rfind('\x1b[2K') < t.output.index('GreatPing accepted')
        for extra in [{}, {'CI': '1'}, {'TERM': 'dumb'}]:
            t = Terminal(['notify', 'Build complete', '--json'], {**env, **extra}, split=True)
            assert json.loads(t.finish()) == {'requestId': 'terminal-notice', 'status': 'accepted'}
            assert 'Sending' not in t.output and '\x1b' not in t.output, t.output
        for extra in [{'CI': '1'}, {'TERM': 'dumb'}]:
            t = Terminal(['notify', 'Build complete'], {**env, **extra}); t.finish()
            assert 'Sending' not in t.output and '\x1b' not in t.output, t.output
        result = subprocess.run([NODE, str(CLI), 'notify', 'Build complete'],
                                env=env, capture_output=True, timeout=5)
        assert result.returncode == 0 and result.stdout == b''
        assert b'Sending' not in result.stderr and b'\x1b' not in result.stderr
        print('PASS Notify interruption, resize, JSON, CI and redirected output preserve terminal state')

        endpoint = 'greatping-api-dev.ueldo343.workers.dev'
        for args in [['login'], ['status'], ['doctor']]:
            t = Terminal(args, env); t.finish()
            assert endpoint not in t.output, t.output
        t = Terminal(['doctor', '--verbose'], env); t.finish()
        assert endpoint in t.output, t.output
        for args in [['doctor'], ['doctor', '--verbose']]:
            t = Terminal(args, {**env, 'GREATPING_TEST_MODE': 'network'}); t.finish(1)
            assert ('--verbose' in args) == (endpoint in t.output), t.output
            assert 'Could not reach GreatPing.' in t.output, t.output
        t = Terminal(['status', '--json'], env, split=True)
        assert json.loads(t.finish())['server'] == f'https://{endpoint}'
        assert t.output == '', t.output
        t = Terminal(['notify', 'Build complete'], {**env, 'GREATPING_TEST_MODE': 'network'})
        t.finish(1)
        assert endpoint not in t.output and 'Could not reach GreatPing.' in t.output, t.output
        print('PASS Service address appears only in explicit diagnostics and compatible status JSON')

        cache = config / 'update-check.json'
        def seed(latest='99.0.0', age=0):
            checked = int(time.time() * 1000) - age
            cache.write_text(json.dumps({'attemptedAt': int(time.time() * 1000),
                'checkedAt': checked, 'latest': latest}))
        updates = {key: value for key, value in env.items() if key != 'NO_UPDATE_NOTIFIER'}
        seed()
        t = Terminal(['ask', 'Deploy?'], updates); t.finish()
        final = screen(t.output, t.cols)
        assert 'Waiting' not in final and 'Ship it' in final and 'Update available' in final, final
        assert final.index('Ship it') < final.index('Update available'), final
        assert 'original package manager or source checkout' in final
        assert cache.stat().st_mtime_ns > 0
        print('PASS A cached newer npm version appears after the result with the update command')

        major, minor, patch = map(int, VERSION.split('.'))
        for latest in [f'{major}.{minor}.{patch + 1}', f'{major}.{minor + 10}.0', f'{major + 1}.0.0']:
            seed(latest)
            t = Terminal(['--help'], updates); t.finish()
            assert 'Update available' in t.output and latest in t.output
        seed()
        t = Terminal(['run', '--', NODE, '-e',
                      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
                      '--', '--no-update-check'], env)
        t.finish()
        assert '["--no-update-check"]' in t.output, t.output
        print('PASS Versions compare numerically and global flags preserve child arguments')

        for latest in [VERSION, '0.0.0', '99.0.0-beta.1', '99.0.0\u001b[2J', None]:
            seed(latest)
            t = Terminal(['--help'], {**updates, 'NO_UPDATE_NOTIFIER': '1'}); t.finish()
            # For invalid metadata, prevent a worker from repairing it with the newer fixture.
            t = Terminal(['--help'], {**updates, 'GREATPING_TEST_NPM': 'hang'}); t.finish()
            assert 'Update available' not in t.output, t.output
        seed(age=8 * 24 * 60 * 60 * 1000)
        t = Terminal(['--help'], updates); t.finish()
        assert 'Update available' not in t.output
        print('PASS Equal, older, prerelease, malformed and stale versions are not advertised')

        seed()
        before = cache.read_bytes()
        for args, extra, split in [(['--help', '--no-update-check'], {}, False),
                                   (['ask', 'Deploy?', '--json'], {}, False),
                                   (['uninstall', '--dry-run'], {}, False),
                                   (['--help'], {'CI': '1'}, False),
                                   (['--help'], {'TERM': 'dumb'}, False),
                                   (['--help'], {'NO_UPDATE_NOTIFIER': '1'}, False),
                                   (['--help'], {}, True)]:
            t = Terminal(args, {**updates, **extra}, split=split); t.finish()
            assert 'Update available' not in t.output, t.output
            assert cache.read_bytes() == before
        print('PASS JSON, uninstall, CI, dumb terminals, pipes and opt-out skip checks')

        for args in [[], ['--version'], ['version']]:
            seed()
            t = Terminal(args, updates); t.finish()
            assert 'Update available' in t.output
        t = Terminal(['--version'], updates, split=True)
        assert t.finish().strip() == VERSION and 'Update available' not in t.output
        t = Terminal([], env); t.finish()
        assert 'Pairing saved on this computer' in t.output
        assert 'Get started with' not in t.output
        print('PASS Paired startup and terminal version notices preserve piped version output')

        seed(VERSION)
        t = Terminal(['update', '--check', '--json'], env, split=True)
        result = json.loads(t.finish())
        assert result['latest'] == '99.0.0' and result['updateAvailable'] is True
        assert t.output == ''
        print('PASS Explicit update checks bypass a fresh cache and notifier opt-out with clean JSON')

        t = Terminal(['update', '--check', '--json'], {**env, 'GREATPING_TEST_NPM': 'offline'}, split=True)
        result = json.loads(t.finish(1))
        assert result['latest'] is None and result['updateAvailable'] is None and result['error']
        assert t.output == ''

        checked = int(time.time() * 1000) - 90 * 60 * 1000
        cache.write_text(json.dumps({'attemptedAt': checked, 'checkedAt': checked, 'latest': VERSION}))
        t = Terminal([], updates); t.finish()
        assert 'Update available' in t.output and '99.0.0' in t.output
        print('PASS Startup discovers an update after one hour; explicit offline checks report unknown')

        t = Terminal(['update', '--check'], {**env, 'GREATPING_TEST_NPM': 'hang'})
        t.wait('Checking npm for updates')
        os.killpg(t.process.pid, signal.SIGINT); t.finish(130)
        final = screen(t.output, t.cols)
        assert 'cancelled' in final and 'Checking npm' not in final
        assert '\x1b[?25h' in t.output
        print('PASS Interrupting an update check clears progress and restores the cursor')

        cache.unlink()
        log = root / 'npm-log'
        t = Terminal(['--help'], {**updates, 'GREATPING_TEST_LOG': str(log)})
        started = time.monotonic(); t.finish()
        assert time.monotonic() - started < 2
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if cache.exists() and json.loads(cache.read_text()).get('latest') == '99.0.0': break
            time.sleep(.05)
        assert json.loads(cache.read_text())['latest'] == '99.0.0'
        assert log.read_text() == 'npm\n'
        assert cache.stat().st_mode & 0o777 == 0o600
        t = Terminal(['--help'], updates); t.finish()
        assert 'Update available' in t.output
        assert log.read_text() == 'npm\n', 'Fresh cache triggered another npm request'
        print('PASS Packaged background worker refreshes once, persists privately and never delays help')

        cache.unlink()
        t = Terminal(['--help'], {**updates, 'GREATPING_TEST_NPM': 'hang',
                                  'GREATPING_TEST_LOG': str(log)})
        started = time.monotonic(); t.finish()
        assert time.monotonic() - started < 2
        assert 'Update available' not in t.output
        t = Terminal(['--help'], updates); t.finish()
        assert json.loads(cache.read_text())['latest'] is None, 'Failed check retried immediately'
        # The hung fixture ignores abort; the worker's overall deadline must stop it.
        time.sleep(5.1)
        print('PASS An unresponsive npm check cannot hold the CLI open or cause immediate retries')
finally:
    for terminal in ACTIVE:
        if terminal.process.poll() is None:
            os.killpg(terminal.process.pid, signal.SIGKILL)
            terminal.process.wait(timeout=2)
        os.close(terminal.master)
