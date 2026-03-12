# Development Notes

## Release Checklist (`codex-run`)

Use this flow for a new release like `0.3.0`.

1. Ensure repo state is correct.

```bash
git remote get-url github
# must be: git@github.com:asfsdsf/codex-run.git

gh auth status -h github.com
git status --short --branch
```

2. Set version in `package.json`.

```bash
pnpm version 0.3.0 --no-git-tag-version
# or edit package.json directly
```

3. Build and verify locally.

```bash
pnpm install
pnpm build
```

4. Commit and tag.

```bash
git add package.json README.dev.md
git commit -m "Release 0.3.0"
git tag -a v0.3.0 -m "v0.3.0"
```

5. Push branch and tag to `github` remote.

```bash
git push -u github $(git rev-parse --abbrev-ref HEAD)
git push github v0.3.0
```

6. Build portable release bundles (Linux/macOS/Windows).

```bash
"$CODEX_HOME/skills/github-release-codex-run/scripts/build-release-bundles.sh" 0.3.0
```

Default assets are generated in `/tmp/codex-run-release-0.3.0/artifacts`:
- `codex-run-v0.3.0-linux-x64.tar.gz`
- `codex-run-v0.3.0-macos-arm64.tar.gz`
- `codex-run-v0.3.0-macos-x64.tar.gz`
- `codex-run-v0.3.0-windows-x64.zip`

7. Create/update GitHub release and upload assets.

```bash
"$CODEX_HOME/skills/github-release-codex-run/scripts/publish-release.sh" 0.3.0
```

By default, release notes are generated from commit subjects between the previous tag and `v0.3.0`. You can override notes with:

```bash
"$CODEX_HOME/skills/github-release-codex-run/scripts/publish-release.sh" 0.3.0 --notes-file /path/to/notes.md
```

8. Verify release page and assets.

```bash
gh release view v0.3.0 -R asfsdsf/codex-run --json assets,url
```
