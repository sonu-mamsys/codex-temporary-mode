# codex-temporary-mode

Keep one-off Codex conversations out of your saved chat history.

Use temporary chats in your terminal, or turn on **Temporary** in VS Code. A purple chat input helps you recognise when it is on.

Unofficial project. Not affiliated with or endorsed by OpenAI.

## What you need

- Node.js 22 or newer.
- Codex installed and signed in.
- For VS Code: Codex extension **26.908.40401**. Other versions are not supported yet.

## Install

Once the npm release is available:

```sh
npm install -g codex-temporary-mode
```

On Windows, use `npm.cmd` if PowerShell blocks `npm`.

## Temporary chats in VS Code

1. Run:

   ```sh
   codex-temporary-mode vscode install
   ```

2. Reload VS Code.
3. Start a new Codex chat and turn on **Temporary**.

Look for the purple input and **Temporary chat** label. Existing conversations keep their original mode.

To check it works, send a message in a new temporary chat and restart VS Code. The chat should no longer appear in history.

If you change the mode from the status bar or Command Palette, reload VS Code before starting your next chat.

## Temporary chats in your terminal

```sh
codex-temporary-mode
```

Type your message to begin. Use `/new` for a fresh chat and `/exit` to leave.

Chats are read-only by default. To let Codex edit files in your project:

```sh
codex-temporary-mode --workspace-write
```

For more options, run `codex-temporary-mode --help`.

## Good to know

- Temporary chats cannot be reopened later. Any file changes still remain.
- Temporary mode does not guarantee zero retention by OpenAI or clear text already shown in your terminal.
- Terminal mode supports text chat, without attachments or interactive approval prompts.
- VS Code support is for local chats only. Cloud chats, remote connections and ChatGPT desktop/web are not supported.
- If the Codex extension updates, you may need a new codex-temporary-mode release.

## Uninstall

Run this from your project folder:

```sh
codex-temporary-mode uninstall
```

This restores detected VS Code installations, removes the saved Temporary setting, and uninstalls the terminal package from your active npm installation. Reload VS Code and close any running temporary chats afterward.

Using a source checkout? Run `bash uninstall.sh` or `.\uninstall.ps1` instead. Run it again safely if already uninstalled.

For a custom extension location, add `--vscode-path <folder>`. For settings in another project or a custom VS Code profile, add `--settings-path <settings.json or .code-workspace>`. Repeat these options for multiple locations. Other machines, WSL environments and npm installations must be cleaned up separately.

Your normal Codex installation, saved conversations, project files and unrelated settings are kept. If restoration is blocked by changed extension files or backups, uninstall reports the problem and keeps the package available for recovery.

## License

[MIT](LICENSE).
