# Contributing to ASKII

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Setup

```bash
git clone https://github.com/danisss9/ASKII.git
cd ASKII && npm install && (cd cli && npm install)
```

- `src/` — VS Code extension host code
- `common/` — pure Node code shared by the extension and the CLI (must never import `vscode`)
- `cli/` — the `askii-cli` npm package
- `media/` — webview scripts and styles (plain browser JavaScript/CSS, loaded via `asWebviewUri`; linted with the rest) and walkthrough pages
- `test/` — mocha (`tdd` UI) suites; they run in plain Node *and* inside VS Code

## Before you open a pull request

```bash
npm run check-types   # extension + CLI
npm run lint          # src, common, test, cli — errors fail CI
npm run test:unit     # fast, plain Node
npm test              # the same suites inside VS Code (needs a display; CI uses xvfb)
```

- Add or update tests for behavior changes — especially anything that touches files, runs
  commands, or parses model output
- Add an entry under `## [Unreleased]` in `CHANGELOG.md`
- Keep `common/` free of `vscode` imports so the CLI and plain-Node tests can load it
- New settings go in `package.json` (with a description, and `"scope": "machine"` if a workspace
  must not be able to set them) and in the README's Configuration tables

## Releasing (maintainers)

1. Bump `version` in **both** `package.json` and `cli/package.json` (they must match — CI checks)
2. Move the `Unreleased` CHANGELOG entries under the new version
3. Commit, then push a tag `askii_<version>` (e.g. `askii_1.0.0`)

The release workflow runs the full CI first, checks the tag against both versions, then publishes
the GitHub release, the npm package, the VS Code Marketplace and Open VSX. Every publish step skips
a version that is already out, so a release that failed half-way can simply be re-run.
