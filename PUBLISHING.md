# Releasing codex-temporary-mode

The npm package contains the CLI and `build/companion.vsix`. VS Code installs the companion separately through `codex-temporary-mode companion install` or `setup --all`. The identical versioned VSIX is attached to the GitHub release. Marketplace publication is a separate, optional distribution channel.

1. Update `package.json`, the root versions in `package-lock.json`, `lib/app-server.mjs`, and `CHANGELOG.md`. Update `companion/package.json` and its README when the companion changes.
2. Run `npm ci --ignore-scripts`, `npm test`, and `npm run test:build`. The build generates minified CLI files, a minified companion VSIX in `dist/`, and the identical `build/companion.vsix`.
3. Inspect `npm pack --dry-run --ignore-scripts` for the companion asset and intended runtime files.
4. Commit the reviewed release and push its matching `v<package-version>` tag. Keep unrelated local changes out of the release.
5. The `Publish to npm` GitHub workflow validates the tag, runs the release gates, publishes through npm trusted publishing/OIDC, and creates a GitHub release with the VSIX. It needs no npm token. Manual dispatch must select the matching version tag.
6. Verify the public npm version and GitHub release asset. Allow for registry propagation before retrying; published npm versions cannot be overwritten.

Users update with `npm i -g codex-temporary-mode@latest`, run `codex-temporary-mode companion install`, then reload VS Code. Updating npm alone does not update an installed VS Code extension. Compatible Codex upgrades are repaired after an explicit patch opt-in; unknown layouts need an updated adapter or the terminal fallback.
