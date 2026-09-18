# GhostThread — Temporary Mode for Codex

Temporary chats for Codex in your terminal and VS Code.

Use GhostThread when you want a conversation that stays out of saved chat history. In VS Code, a **Temporary** switch and purple input background make the mode easy to recognise.

Unofficial project. Not affiliated with or endorsed by OpenAI.

## Before you start

- Node.js 22 or newer.
- Codex installed and signed in. Run `codex login` if needed.
- For VS Code: Codex extension **26.908.40401**. Other versions are not supported yet.

## Install

For a published npm release:

```powershell
npm install -g ghostthread
```

If you have the project files and local release package, use:

```powershell
npm install -g .\dist\ghostthread-3.2.1.tgz
```

On Windows, use `npm.cmd` instead of `npm` if PowerShell blocks the command.

## Use in the terminal

Start a temporary chat:

```powershell
ghostthread
```

By default, GhostThread cannot edit your project files. To allow changes, run:

```powershell
ghostthread --workspace-write
```

| Command | What it does |
| --- | --- |
| `/new` | Start a fresh temporary chat |
| `/status` | Show the current chat's temporary status |
| `/exit` | Close the chat |

Run `ghostthread --help` for more options.

## Use in VS Code

1. Enable GhostThread for the supported extension:

   ```powershell
   ghostthread vscode install
   ```

2. Reload VS Code.
3. Open a new Codex chat and turn on **Temporary**.

Temporary chats have a purple input background and a **Temporary chat** label. The switch applies to new chats; it does not change existing conversations.

If you switch modes using the VS Code status bar or Command Palette, reload the window before starting a new chat.

## Check that it works

In the terminal:

```powershell
ghostthread --verify "Reply only TEMP-TEST. Do not use tools."
```

You should see the reply followed by **PASS**. This checks that the test chat cannot be reopened after the session closes and has no matching local session files.

In VS Code, create a new temporary chat, send a message, then restart VS Code. That chat should not appear in history.

## What to know

- Temporary chats are not saved for later resuming. File edits still remain.
- This does not guarantee zero retention by OpenAI or remove terminal scrollback.
- The terminal provides basic text chat. Features such as attachments and interactive approval prompts are not supported.
- VS Code support covers local chats. Cloud chats, remote connections, ChatGPT desktop and ChatGPT web are not supported.
- A Codex extension update may require a new GhostThread release.

## Remove GhostThread

If you enabled it in VS Code, restore the extension first:

```powershell
ghostthread vscode restore
npm uninstall -g ghostthread
```

Reload VS Code afterward.


## License

[MIT](LICENSE).
