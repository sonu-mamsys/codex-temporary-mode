# Codex Temporary Companion

Unofficial local VS Code extension. Not affiliated with or endorsed by OpenAI.

This extension owns its commands and status control independently of Codex, so updating `openai.chatgpt` does not replace them. It repairs the embedded Temporary toggle when the installed Codex bundles match a reviewed compatibility profile. If they do not, the control stays available and offers the existing temporary terminal client.

## Install

Install the companion bundled with the npm package:

```sh
npm i -g codex-temporary-mode@latest
codex-temporary-mode companion install
```

The combined `codex-temporary-mode setup --all` command also installs the companion. Rerun `companion install` after updating npm to update this extension. Use `--code-path <absolute CLI path>` or `--profile <name>` to select another VS Code installation/profile.

Or download the VSIX from [GitHub releases](https://github.com/sonusharma26/codex-temporary-mode/releases) and select **Extensions: Install from VSIX...** in VS Code. Source builds use `npm run package:companion` and produce `dist/codex-temporary-companion-0.1.1.vsix`. Reload the window after installation. Use **Temporary Chat: Open Controls**, or click **Temporary Chat** in the status bar.

## Embedded mode

After a previous explicit patch installation, compatible updates are repaired on VS Code startup and extension-change notifications. First-time users choose **Temporary Chat: Repair Embedded Toggle** to opt in. The companion uses VS Code's selected `openai.chatgpt` extension path rather than guessing from folder timestamps.

A repair changes files on disk. Reload VS Code when prompted before using the embedded toggle. **Toggle Embedded Mode** also requires a reload to discard chats prewarmed in the previous storage mode. The toggle inside the Codex composer clears those prewarmed chats itself.

Unknown layouts are left untouched. The status control says **Terminal available** and does not claim that ordinary Codex chats are temporary. Updating the companion may be necessary after a substantial Codex change. No private renderer patch can promise compatibility with every future Codex version.

Use **Temporary Chat: Restore Original Codex Files** to restore verified backups and clear the patcher's repair opt-in, then reload. This command works even if an older global npm package does not understand the companion's newer patch manifest. Uninstalling this companion removes its controls and update checks; it does not restore a separately installed Codex patch.

Disable **Temporary Companion: Auto Repair** to stop only the companion's automatic repairs. The npm terminal launcher has its own repair check; `CODEX_TEMPORARY_SKIP_VSCODE_REPAIR=1` disables it.

## Temporary terminal client

**Temporary Chat: Start Terminal Chat** opens the bundled terminal client directly with Node.js, without shell command interpolation. It requires Node.js 22.13+, Codex CLI on PATH, and an existing Codex login. Use **Temporary Companion: Node Path** if Node.js is not on VS Code's PATH.

The terminal client defaults to a read-only sandbox and sends no prompt unless the server confirms an ephemeral thread without a session file. Its commands are more limited than the native Codex UI. It still depends on the Codex app-server protocol; a protocol-breaking update may need a client update.

This version manages local desktop VS Code installations in trusted workspaces. In SSH/WSL/other remote windows, run `codex-temporary-mode` in a terminal on the remote host; the companion does not reinterpret remote paths as local directories.

The companion installs no background service and downloads or executes no adapter updates. Upgrade the companion explicitly when a new adapter is needed.
