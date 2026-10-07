#!/usr/bin/env node
// Generate self-contained host packages from the canonical skill and bridge.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === '--check';
const output = args.length === 2 && args[0] === '--output' ? resolve(args[1]) : null;
if (args.length && !check && !output) {
  console.error('Usage: node scripts/build-agent-plugins.mjs [--check | --output <directory>]');
  process.exit(1);
}

const VERSION = '0.2.0';
const repository = 'https://github.com/nobottomline/greatping';
const author = { name: 'Great Love', url: 'https://greatping.com' };
const skill = readFileSync(join(root, 'skills/greatping/SKILL.md'), 'utf8');
const bridge = readFileSync(join(root, 'plugins/shared/bridge.mjs'), 'utf8');
const license = readFileSync(join(root, 'LICENSE'), 'utf8');
const catalogs = existsSync(join(root, 'oss/package.json')) ? join(root, 'oss') : root;
const files = new Map();
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const events = {
  claude: [
    ['PreToolUse', 'AskUserQuestion'],
    ['PermissionRequest', '.*'],
    [
      'Notification',
      'elicitation_dialog|elicitation_url_dialog|elicitation_complete|elicitation_response',
    ],
    ['PostToolUse', '.*'],
    ['PostToolUseFailure', '.*'],
    ['PermissionDenied', '.*'],
    ['UserPromptSubmit'],
    ['Stop', null, true],
    ['SessionEnd', null, true],
  ],
  codex: [['Stop', null, true], ['UserPromptSubmit'], ['SessionStart'], ['SessionEnd', null, true]],
};

for (const host of ['claude', 'codex']) {
  const directory = `plugins/${host}/greatping`;
  // These placeholders are expanded by the host, not by this build process.
  const variable = `\${${host === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT'}}`;
  const name = host === 'claude' ? 'Claude Code' : 'Codex';
  const description =
    host === 'claude'
      ? 'Phone alerts for native questions and permissions, with explicit GreatPing MCP tools.'
      : 'Phone alerts when Codex finishes a turn, with explicit GreatPing MCP tools.';
  const metadata = {
    name: 'greatping',
    version: VERSION,
    description,
    author,
    homepage: `${repository}#agent-plugins`,
    repository,
    license: 'MIT',
    keywords: ['notifications', 'mcp', host],
  };
  const server = {
    command: 'node',
    args: [`${variable}/scripts/bridge.mjs`, host, 'mcp'],
  };
  const hooks = Object.fromEntries(
    events[host].map(([event, matcher, sync]) => [
      event,
      [
        {
          ...(matcher ? { matcher } : {}),
          hooks: [
            {
              type: 'command',
              command:
                host === 'claude' ? 'node' : `node "${variable}/scripts/bridge.mjs" ${host} hook`,
              ...(host === 'claude'
                ? { args: [`${variable}/scripts/bridge.mjs`, host, 'hook'] }
                : {}),
              ...(sync ? {} : { async: true }),
              timeout: 10,
            },
          ],
        },
      ],
    ]),
  );
  files.set(`${directory}/hooks/hooks.json`, json({ hooks }));
  files.set(`${directory}/scripts/bridge.mjs`, bridge);
  files.set(`${directory}/skills/greatping/SKILL.md`, skill);
  files.set(`${directory}/LICENSE`, license);
  if (host === 'claude') {
    files.set(`${directory}/.claude-plugin/plugin.json`, json(metadata));
    files.set(`${directory}/.mcp.json`, json({ greatping: server }));
  } else {
    files.set(
      `${directory}/plugin.json`,
      json({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        ...metadata,
        extensions: {
          'com.openai': {
            hooks: './hooks/hooks.json',
            interface: {
              displayName: 'GreatPing',
              shortDescription: 'Alerts on your phone',
              developerName: 'Great Love',
              category: 'Productivity',
            },
          },
        },
      }),
    );
    files.set(
      `${directory}/mcp.json`,
      json({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: { greatping: { type: 'stdio', ...server } },
      }),
    );
    // Older local Codex clients still use this manifest and .mcp.json.
    files.set(
      `${directory}/.codex-plugin/plugin.json`,
      json({ ...metadata, hooks: './hooks/hooks.json', mcpServers: './.mcp.json' }),
    );
    files.set(`${directory}/.mcp.json`, json({ greatping: server }));
  }
  files.set(
    `${directory}/README.md`,
    `# GreatPing for ${name}\n\n${description}\n\nThis preview plugin requires an installed GreatPing CLI >=0.4.0 and <1.0.0,\nand Node.js >=22.20.0 available to the host. It does not download a runtime or\npair your computer. Run \`greatping login\` yourself if pairing is needed.\n\nUse \`greatping setup ${host}\` and \`greatping doctor\`.
For an explicit launcher, run from this directory in your terminal:\n\n\`\`\`sh\nnode scripts/bridge.mjs ${host} configure\nnode scripts/bridge.mjs ${host} check\n\`\`\`\n\nConfigure once; the launcher is stored outside the plugin cache and survives\nplugin updates. ${host === 'claude' ? 'Completion alerts are off by default; pass `--finished` to configure to enable them. Existing completion preferences are preserved.' : 'Completion alerts are on by default; pass `--no-finished` to configure to disable them. Review and trust hooks in `/hooks`; installing a plugin does not grant trust. Native permissions and questions are not automatically covered.'}\n\nIf CLI integrations already exist, migrate them through their installer.\nPlugin hooks stand by while legacy CLI hooks are installed, and plugin MCP\nrefuses to start beside a separately registered \`greatping\` server.\n\nSee [installation, migration and removal](${repository}/blob/main/plugins/README.md)\nfor exact commands, stable launchers, coverage and verification limits.\n\nGenerated by \`scripts/build-agent-plugins.mjs\`; edit the shared source and\ncanonical skill, then regenerate both packages.\n`,
  );
}

for (const host of ['opencode', 'pi']) {
  const directory = `plugins/${host}/greatping`;
  files.set(`${directory}/index.js`, readFileSync(join(root, `plugins/shared/${host}.js`), 'utf8'));
  files.set(`${directory}/bridge.mjs`, bridge);
  files.set(
    `${directory}/native.mjs`,
    readFileSync(join(root, 'plugins/shared/native.mjs'), 'utf8'),
  );
  files.set(`${directory}/skills/greatping/SKILL.md`, skill);
  files.set(`${directory}/LICENSE`, license);
  files.set(
    `${directory}/package.json`,
    json({
      name: `@greatping/${host}`,
      version: '0.1.1',
      type: 'module',
      license: 'MIT',
      description: `GreatPing native ${host} adapter, phone alerts, tools and skill.`,
      repository,
      files: ['index.js', 'bridge.mjs', 'native.mjs', 'skills', 'LICENSE', 'README.md'],
      engines: { node: '>=22.20.0' },
      ...(host === 'pi'
        ? {
            keywords: ['pi-package', 'notifications'],
            pi: { extensions: ['./index.js'], skills: ['./skills'] },
          }
        : { main: './index.js' }),
    }),
  );
  files.set(
    `${directory}/README.md`,
    `# GreatPing for ${host === 'pi' ? 'Pi' : 'OpenCode'}

Native preview. Requires a GreatPing CLI build with OpenCode/Pi adapter support;
requires CLI >=0.4.0. No runtime download, pairing or PATH edits.

Use \`greatping setup ${host} --yes\` to install the bundled adapter offline,
then restart the host. \`greatping doctor\` checks the launcher and ownership.
Completion alerts default on; \`--no-finished\` disables them.

See [coverage, distribution and qualification](${repository}/blob/main/plugins/native-adapters.md).
Generated from canonical sources by \`scripts/build-agent-plugins.mjs\`.
`,
  );
}

{
  const directory = 'plugins/cursor/greatping';
  const cursorRoot = `\${CURSOR_PLUGIN_ROOT}`;
  files.set(
    `${directory}/.cursor-plugin/plugin.json`,
    json({
      name: 'greatping',
      version: VERSION,
      description:
        'Phone alerts when Cursor IDE finishes successfully, with GreatPing MCP tools and skill.',
      author: { name: author.name },
      repository,
      license: 'MIT',
      hooks: './hooks/hooks.json',
      mcpServers: './mcp.json',
      skills: './skills',
    }),
  );
  files.set(`${directory}/scripts/bridge.mjs`, bridge);
  files.set(`${directory}/skills/greatping/SKILL.md`, skill);
  files.set(`${directory}/LICENSE`, license);
  files.set(
    `${directory}/hooks/hooks.json`,
    json({
      version: 1,
      hooks: Object.fromEntries(
        ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd'].map((event) => [
          event,
          [
            {
              command: `node "${cursorRoot}/scripts/bridge.mjs" cursor hook`,
              timeout: 10,
            },
          ],
        ]),
      ),
    }),
  );
  files.set(
    `${directory}/mcp.json`,
    json({
      mcpServers: {
        greatping: {
          command: 'node',
          args: [`${cursorRoot}/scripts/bridge.mjs`, 'cursor', 'mcp'],
        },
      },
    }),
  );
  files.set(
    `${directory}/README.md`,
    `# GreatPing for Cursor IDE

Native preview: successful completion alerts, MCP tools and the shared skill.
Requires Node.js >=22.20.0 and a plugin-aware GreatPing CLI build. Released CLI
0.3.3 does not include this installer; update to CLI >=0.4.0. No runtime downloads or PATH changes.

Run \`greatping setup cursor --yes\`, then reload Cursor and inspect Customize.
The installer copies the plugin into \`~/.cursor/plugins/local/greatping\`.
Local imports must be allowed; a marketplace install with the same name takes
precedence. Use the native manager for that install. Completion defaults on;
\`--no-finished\` disables it. Remove the owned local copy with
\`greatping setup cursor --remove --yes\`; pairing remains intact.

Native questions and permission waiting are not automatically covered by the
documented Cursor hook API. Explicit GreatPing tools are available. This package
targets the IDE; Cursor Agent CLI plugin loading is not qualified.

See [Cursor integration](${repository}/blob/main/plugins/cursor.md).
Generated from canonical sources by \`scripts/build-agent-plugins.mjs\`.
`,
  );
  files.set(
    '.cursor-plugin/marketplace.json',
    json({
      name: 'greatping',
      owner: { name: author.name },
      plugins: [{ name: 'greatping', source: './plugins/cursor/greatping', version: VERSION }],
    }),
  );
}

files.set(
  '.claude-plugin/marketplace.json',
  json({
    name: 'greatping',
    owner: author,
    metadata: { description: 'GreatPing phone alerts and agent tools.' },
    plugins: [
      {
        name: 'greatping',
        source: './plugins/claude/greatping',
        version: VERSION,
        description: 'GreatPing phone alerts, MCP tools and skill for Claude Code.',
      },
    ],
  }),
);
files.set(
  '.agents/plugins/marketplace.json',
  json({
    name: 'greatping',
    interface: { displayName: 'GreatPing' },
    plugins: [
      {
        name: 'greatping',
        source: { source: 'local', path: './plugins/codex/greatping' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ],
  }),
);

let failed = false;
for (const [file, content] of files) {
  // Public root catalogs are overlaid by the existing OSS exporter.
  const target = output ? join(output, file) : join(file.startsWith('.') ? catalogs : root, file);
  if (check) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content) {
      console.error(`Plugin output is out of date: ${file}`);
      failed = true;
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
if (failed) process.exitCode = 1;
else
  console.log(
    check
      ? 'Agent plugin packages match their sources.'
      : 'Generated Claude Code, Codex, OpenCode, Pi and Cursor packages.',
  );
