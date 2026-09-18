# Publishing

The npm package links to [sonu-mamsys/codex-temporary-mode](https://github.com/sonu-mamsys/codex-temporary-mode). The repository, homepage and issue links are set in package.json.

## Publish from your computer

Run `npm ci`, then `npm publish --access public`. The publish command tests source and built code, rebuilds the release, and publishes only the build, README, license and package metadata. Complete npm's authentication prompt if requested.

Use a new version for each release. Update package.json, package-lock.json and the client version in lib/app-server.mjs together.

## Publish directly from GitHub

The workflow `.github/workflows/publish.yml` is ready. To enable it:

1. On npm, open **codex-temporary-mode > Settings > Trusted publishing**.
2. Choose **GitHub Actions**.
3. Enter owner **sonu-mamsys**, repository **codex-temporary-mode**, and workflow filename **publish.yml**. Leave environment blank.
4. Save the trusted publisher configuration.
5. For a new version, push the changes and publish a GitHub Release for that commit. You can also run **Publish to npm** manually from the Actions tab.

This uses GitHub's identity instead of storing an npm token. Configure trust before running the workflow. Do not run it for a version already published locally.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for account setup and requirements.

## Uninstall

Users run `codex-temporary-mode uninstall`. Source checkouts also offer `bash uninstall.sh` and `uninstall.ps1`. The command cleans detected extensions and settings first, then removes the package from the active global npm prefix. Custom locations can be supplied with `--vscode-path` and `--settings-path`. It does not search every folder or remove other npm installations, saved chats or project files.
