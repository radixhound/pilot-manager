# Claude Code Instructions for pilot-manager

## Publishing / Releasing

- This package is NOT published to npm. It is installed from the git repo.
- **Always bump the version in `package.json` when merging a PR.** Use semver:
  - Patch (0.x.Y) for bug fixes
  - Minor (0.Y.0) for new features
  - Major (Y.0.0) for breaking changes
- Install/upgrade command: `npm install -g git+https://github.com/radixhound/pilot-manager.git`
