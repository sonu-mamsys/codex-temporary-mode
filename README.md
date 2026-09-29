# codex-temporary-mode

Temporary Codex chats, plus an optional local coding accelerator for Delta Mode and Pipeline Mode.

> **Unofficial project. Not affiliated with or endorsed by OpenAI.**

## Get started in 60 seconds

```sh
npm i -g codex-temporary-mode
cd /path/to/your/git-repository
codex-temporary-mode setup --all
codex-temporary-mode doctor
```

`setup --all` installs the VS Code Temporary Mode patch and configures the current Git project's optional MCP accelerator. It changes only the detected local extension and the project's `.codex/` files. `setup` without `--all` remains the existing combined-command alias. `doctor` is read-only and reports exactly what was found.

Want just one feature instead?

* **Do not save a local VS Code Codex conversation:** `codex-temporary-mode temporary install`
* **Use temporary chats in the terminal:** run `codex-temporary-mode`
* **Reduce repeated file/context output and run checkpoints:** `codex-temporary-mode accelerator setup`

## Feature and client support

| Feature | Codex CLI | VS Code Codex | ChatGPT desktop | ChatGPT web |
| --- | --- | --- | --- | --- |
| Temporary Mode | Yes | Yes | No | No |
| Delta Mode (local MCP) | Yes | Yes | Yes | No |
| Pipeline Mode (local MCP) | Yes | Yes | Yes | No |

Temporary Mode and the accelerator are separate: the VS Code patch enables temporary local chats, while the accelerator is a project-scoped local MCP server. Use `codex-temporary-mode doctor --json` for a support-friendly, machine-readable local report.

Use Codex without saving one-off conversations to your chat history.

Works with:

* **VS Code Codex** — adds a **Temporary** mode to new chats.
* **Codex CLI** — starts temporary terminal chats.

* **Codex MCP clients** — expose an optional local Delta Mode accelerator.

## Detailed installation

Requirements:

* Node.js 22.13+
* Codex installed and signed in
* A structurally compatible local VS Code Codex extension for Temporary Mode; run `doctor` after extension updates

Install globally:

```sh
npm i -g codex-temporary-mode
cd /path/to/your/repository
codex-temporary-mode setup --all
```

`setup --all` performs the three local steps:

* Enables Temporary Mode in the installed VS Code Codex extension.
* Adds the Delta and Pipeline MCP server to the trusted project's `.codex/config.toml`.
* Generates `.codex/accelerator.json` when standard Node.js, Cargo, or .NET validation commands can be detected.

Run `setup` once in each repository where you want Delta and Pipeline Mode, then restart Codex or reload VS Code once. The generated MCP configuration uses the exact repository path, so validation cannot silently move to another workspace.

> On Windows, use `npm.cmd` if PowerShell blocks `npm`.

## VS Code

If you enabled VS Code support during installation, start a new Codex chat and turn on **Temporary**.

The local new-chat composer and VS Code status bar both have a **Temporary** toggle. In the current composer, the toggle sits inside the chat box, above the text input. The composer toggle clears prewarmed threads when switching modes, so the next message uses the selected mode. Existing chats keep their original mode and temporary chats show a **Temporary chat** label.

Temporary conversations are not saved after VS Code restarts. The original composer layout also highlights the input in purple.

If you skipped VS Code setup during installation, run:

```sh
codex-temporary-mode temporary install
```

Then reload VS Code once.

After an explicit install, terminal startup performs a lightweight compatibility check. If a Codex extension update removed the patch and the new bundle still matches a known structural profile, the patch is restored automatically. Incompatible layouts are left untouched and reported by `doctor`; no background daemon is installed.

You can also inspect or retry the patch directly:

```sh
codex-temporary-mode temporary check
codex-temporary-mode temporary reapply
```

If you change Temporary Mode from the status bar or Command Palette, reload VS Code before starting the next chat.

## Terminal

Start a temporary Codex chat:

```sh
codex-temporary-mode
```

Useful commands:

```text
/new    Start a new temporary chat
/exit   Exit
```

By default, Codex cannot modify your files.

To allow file changes:

```sh
codex-temporary-mode --workspace-write
```

See all options:

```sh
codex-temporary-mode --help
```

## Delta Mode (v0.1)

Delta Mode is a separate local MCP process. It does not patch Codex and it does not intercept native tools. It exposes five tools:

* `read_file_delta` — exact full text on first read, then unchanged markers or textual diffs
* `run_command_delta` — compact, deterministic diagnostic changes between compatible runs
* `get_raw_output` — paged access to retained stdout/stderr when compact output is insufficient
* `reset_context_generation` — forces full source rehydration after compaction, resume, or uncertainty
* `get_acceleration_stats` — exact session byte savings for source delivery and compact command results

File responses report exact full-source, delivered-text, and saved-text byte counts. These measure transmitted source or diff text, not estimated model tokens.

The accelerator setup command adds the STDIO server automatically:

```sh
codex-temporary-mode accelerator setup
```

`codex-temporary-mode setup --skip-vscode` remains available for existing scripts. For manual setup, use a trusted project's `.codex/config.toml`:

```toml
[mcp_servers.codex_accelerator]
command = "codex-accelerator"
args = ["mcp", "--workspace", "."]
cwd = "/absolute/path/to/repository"
default_tools_approval_mode = "writes"
tool_timeout_sec = 1800
env_vars = ["CODEX_ACCELERATOR_EPHEMERAL"]
```

The ChatGPT desktop app, Codex CLI, and Codex IDE extension share local MCP configuration. Restart the relevant client after adding the server, then use `/mcp` where available to verify the accelerator tools.

By default, SQLite state is stored in the OS-local application data directory, never inside the repository. Complete raw command output is retained outside the repository and removed when the MCP session ends. Pass `--ephemeral` to keep SQLite in memory as well. The `codex-temporary-mode` terminal client marks configured accelerator children ephemeral; the `env_vars` entry above allows Codex to forward that marker.

Commands are launched directly with an argument array and no shell. Delta Mode v0.1 rejects batch and PowerShell scripts; on Windows it resolves `npm` and `npx` through their JavaScript entry points.

`--max-output-bytes` is an explicit safety override: when set and exceeded, the command is stopped and the raw result is marked truncated. Without that option, raw output is retained in full for the session.

## Pipeline Mode (v0.2)

Pipeline Mode runs deliberately requested validation checkpoints against isolated workspace snapshots. Codex can continue editing while the single local worker validates the captured workspace. Results always identify the exact workspace tested; a stale pass never validates newer code.

It adds five MCP tools:

* `create_checkpoint` — capture and queue the current workspace
* `get_pipeline_status` — inspect the active worker and collapsed queue
* `get_latest_validation` — retrieve a compact result with current/stale freshness
* `cancel_checkpoint` — cancel queued or active work
* `run_final_validation` — block until the configured final profile validates the current workspace

Validation commands come only from the trusted repository configuration `.codex/accelerator.json`; MCP calls cannot supply arbitrary commands:

```json
{
  "pipeline": {
    "maxWorkers": 1,
    "profiles": {
      "targeted": [
        { "id": "tests", "executable": "npm", "args": ["test"], "parser": "vitest" }
      ],
      "final": [
        { "id": "tests", "executable": "npm", "args": ["test"], "parser": "vitest" }
      ]
    }
  }
}
```

Checkpointing is manual in v0.2. Queued checkpoints for the same profile collapse to the newest workspace, while a running validation is allowed to finish and is reported as historical if the live workspace changed. Raw command output remains available through `get_raw_output`.

For targeted profiles, Pipeline Mode deterministically derives likely tests from changed JavaScript/TypeScript files, same-name test conventions, and direct relative import consumers. Only commands explicitly configured with the `vitest` or `jest` parser receive selected test paths; every other configured command remains unchanged. The selected impact and exact resulting command plan are included in checkpoint identity and results.

Commands in a profile run in order and stop after a failure. Set `"continueOnFailure": true` on a command when later checks are independent and should still run.

## Diagnostics

Run a read-only check before reporting an issue or after a Codex/VS Code update:

```sh
codex-temporary-mode doctor
codex-temporary-mode doctor --json
```

It checks the local Node version, Git workspace, Codex CLI (`codex mcp list`), installed VS Code extension and patch manifest, and the project MCP/Pipeline configuration. It does not modify extension files, configuration, authentication, or workspace data.

## Uninstall

Run:

```sh
codex-temporary-mode uninstall
```

This:

* Restores supported VS Code Codex installations
* Removes the Temporary Mode setting
* Uninstalls `codex-temporary-mode`

Then reload VS Code once.

Your normal Codex installation, saved chats, project files, and unrelated VS Code settings are not removed.

## Limitations

* Temporary chats cannot be reopened later.
* Files changed during a temporary chat are **not** reverted.
* Temporary Mode does not guarantee zero retention by OpenAI.
* Terminal mode currently supports text chat only.
* VS Code support currently works with local chats only.
* Temporary-chat patching does not support cloud chats, remote connections, ChatGPT web, or ChatGPT desktop; Delta Mode uses the separate shared local MCP configuration.
* VS Code patching checks the extension, renderer and composer structure. `26.908.40401` uses the original composer control; `26.917.62051` uses the shared Codex composer across sidebar, editor-panel and empty draft views. Installation rejects layouts without a verified composer hook.

## License

[MIT](LICENSE)
