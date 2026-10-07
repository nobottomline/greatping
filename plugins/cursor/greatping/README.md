# GreatPing for Cursor IDE

Native preview: successful completion alerts, MCP tools and the shared skill.
Requires Node.js >=22.20.0 and a plugin-aware GreatPing CLI build. Released CLI
0.3.3 does not include this installer; update to CLI >=0.4.0. No runtime downloads or PATH changes.

Run `greatping setup cursor --yes`, then reload Cursor and inspect Customize.
The installer copies the plugin into `~/.cursor/plugins/local/greatping`.
Local imports must be allowed; a marketplace install with the same name takes
precedence. Use the native manager for that install. Completion defaults on;
`--no-finished` disables it. Remove the owned local copy with
`greatping setup cursor --remove --yes`; pairing remains intact.

Native questions and permission waiting are not automatically covered by the
documented Cursor hook API. Explicit GreatPing tools are available. This package
targets the IDE; Cursor Agent CLI plugin loading is not qualified.

See [Cursor integration](https://github.com/nobottomline/greatping/blob/main/plugins/cursor.md).
Generated from canonical sources by `scripts/build-agent-plugins.mjs`.
