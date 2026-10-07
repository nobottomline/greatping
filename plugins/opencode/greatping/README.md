# GreatPing for OpenCode

Native preview. Requires a GreatPing CLI build with OpenCode/Pi adapter support;
requires CLI >=0.4.0. No runtime download, pairing or PATH edits.

Use `greatping setup opencode --yes` to install the bundled adapter offline,
then restart the host. `greatping doctor` checks the launcher and ownership.
Completion alerts default on; `--no-finished` disables them.

See [coverage, distribution and qualification](https://github.com/nobottomline/greatping/blob/main/plugins/native-adapters.md).
Generated from canonical sources by `scripts/build-agent-plugins.mjs`.
