# @radnine/claude-pilot-manager

Per-machine supervisor for `@radnine/claude-session-daemon` instances. Install it once on a machine, register your projects, and it handles starting, monitoring, restarting, and upgrading all your daemons from one place.

## Quick Start

```bash
# Install from the current pre-release GitHub source
npm install -g git+https://github.com/radixhound/pilot-manager.git

# Initialize (prompts for server URL and base port)
pilot-manager init

# Scan a parent directory for projects
pilot-manager scan ~/projects

# Register all projects with the Rails server
pilot-manager register

# Install and start all daemons via launchd
pilot-manager install

# Check status
pilot-manager list
```

Or do it all in one step:

```bash
pilot-manager setup ~/projects --server http://localhost:3000 --yes
```

## Commands

### Registry

| Command | Description |
|---------|-------------|
| `init` | Interactive setup, writes `config.yml` |
| `add <path> [--name X] [--port N]` | Add a project to the registry |
| `remove <name>` | Remove a project from the registry |
| `list` | List all registered projects with status |
| `scan <dir> [--yes]` | Auto-discover projects in subdirectories |

### Services (launchd)

| Command | Description |
|---------|-------------|
| `install [name]` | Generate plist + start via launchd (all if no name) |
| `uninstall [name]` | Stop + remove plist (all if no name) |
| `start [name]` | Start service (all if no name) |
| `stop [name]` | Stop service (all if no name) |
| `restart [name]` | Stop + regenerate plist + start (all if no name) |
| `reinstall [name]` | Alias for restart (picks up config changes) |
| `logs <name> [--stdout]` | Tail daemon logs |

### Registration

| Command | Description |
|---------|-------------|
| `register [name] [--server URL] [--force]` | Register with Rails server (all if no name) |
| `deregister [name]` | Revoke token and clear from config |
| `token <name> [--reveal]` | Show auth token |
| `setup <dir> [--server URL] [--yes]` | Scan + register + install in one step |

> An explicit `--server URL` on `register`, `setup`, or `seed` is persisted to
> `config.yml` (`server_url`), so a later `install` bakes the right server into
> the daemon's plist instead of the localhost default.

### Seed

| Command | Description |
|---------|-------------|
| `seed <target-root> [--server URL]` | Download + install the Command Center seed vault |

### Managed FlightDeck maintenance

| Command | Description |
|---------|-------------|
| `sync-core <command-center-path> [--server URL]` | Safely reconcile FlightDeck-managed core crew files |
| `maintain <project-name> --command-center <path> [--server URL]` | Safely fast-forward a configured FlightDeck checkout, then synchronize core crew |

### Other

| Command | Description |
|---------|-------------|
| `upgrade [--version X]` | Upgrade daemon to latest (or specified) npm version and restart services |
| `version` | Show versions (manager, daemon, node) |

## Configuration

All config lives in `~/.config/claude-pilot-manager/`:

```
~/.config/claude-pilot-manager/
├── config.yml        # Global settings
├── projects.yml      # Project registry
├── managed-core/     # Hashed per-vault/per-server ownership state
├── env/
│   ├── _default.env  # Shared env vars for all daemons
│   └── <project>.env # Per-project env vars
└── logs/
    ├── <project>.stdout.log
    └── <project>.stderr.log
```

### config.yml

```yaml
server_url: http://localhost:3000
base_port: 3601
auto_restart: true
log_level: info
max_sessions_per_project: 10
```

### projects.yml

```yaml
projects:
  my-project:
    path: /Users/me/my-project
    port: 3601
    pilot_id: my-project-pilot
    auth_token: null
    auto_restart: true
    extra_env:
      CUSTOM_VAR: value
```

## Seeding a Command Center vault

`seed` downloads the packaged "Command Center" vault that the FlightDeck server
ships and installs it onto this machine:

```bash
pilot-manager seed ~/projects/radnine --server http://localhost:3000
# → ~/projects/radnine/command-center/
```

It fetches `<server>/seed/command-center.tar.gz`, extracts and verifies it in a
staging area, then moves it into `<target-root>/command-center`. The delivery is
**refuse-don't-clobber** (it aborts if `<target-root>/command-center` already
exists) and **atomic** (a corrupt download or an invalid vault leaves the target
untouched — nothing is half-written). On success it prints the personas found
and the suggested follow-up: `pilot-manager add <target-root>/command-center`.

Extraction shells out to `tar`, so `seed` is macOS-only like the rest of
pilot-manager. If the server returns 404, it hasn't packaged a seed yet (or is
too old to ship one).

## Synchronizing managed core crew

`seed` remains create-only. Existing Command Center installations use the
separate managed-core contract:

```bash
pilot-manager sync-core ~/projects/radnine/command-center \
  --server http://localhost:3000
```

The command fetches FlightDeck's versioned ten-path allowlist, validates its
UTF-8 content, SHA-256 values, entry versions, release digest, and contained
symlinks, then preflights every destination before writing. Missing managed
paths are installed. Identical content is adopted without a rewrite. A path
that differs without an ownership record returns `NEEDS_DECISION`; a managed
path changed or deleted after adoption returns `BLOCKED`. No user-created path
outside the allowlist is changed.

Ownership state lives under
`~/.config/claude-pilot-manager/managed-core/`. File names and identity fields
are hashes of the canonical vault path and server identity; state contains only
the last managed release plus each path's kind and content hash. It stores no
server URL, credential, token, or managed file content.

For the bounded Flight Engineer maintenance operation, register the FlightDeck
checkout in Pilot Manager and run:

```bash
pilot-manager maintain flight-deck \
  --command-center ~/projects/radnine/command-center \
  --server http://localhost:3000
```

`maintain` requires a clean Git working tree, an attached branch, a configured
upstream, and no local-ahead or diverged state. It fetches that upstream and
fast-forwards only when strictly behind, then runs the same managed-core sync.
It never switches branches, rebases, resets, stashes, cleans, force-updates,
runs migrations, installs dependencies, restarts services, or updates Pilot
Manager itself.

Both commands print one stable result token. `UPDATED` and `ALREADY_CURRENT`
exit zero. `BLOCKED` exits 2 and `NEEDS_DECISION` exits 3 with concise evidence.

## Updating Pilot Manager

Pilot Manager is not published to the npm registry. During the current
pre-release period, install or update it from GitHub:

```bash
npm install -g git+https://github.com/radixhound/pilot-manager.git
```

This documents the current delivery source; it is not a permanent release or
publishing policy.

## Re-registering Daemons

If the server is reset or tokens become invalid, daemons will fail to connect and launchd will restart them in a loop. To recover:

```bash
# 1. Stop all daemons (breaks the restart loop)
pilot-manager stop

# 2. Force re-register all projects (revokes old tokens, gets new ones)
pilot-manager register --force

# 3. Reinstall all services (regenerates plists with new tokens + starts)
pilot-manager reinstall
```

The `--force` flag suspends the existing pilot registration on the server and creates a fresh one with a new auth token.

## How It Works

The pilot-manager generates macOS launchd plist files for each registered project. Each plist tells launchd to:

- Run the `@radnine/claude-session-daemon` for that project
- Set environment variables (port, auth token, working directory)
- Auto-restart on crash (`KeepAlive`)
- Start on boot (`RunAtLoad`)
- Log stdout/stderr to files

The pilot-manager itself is **not** a long-running process. It's a CLI that generates configuration and delegates process management to launchd.

## Requirements

- Node.js >= 18
- macOS (uses launchd)
- `@radnine/claude-session-daemon` installed
- A running rad-project Rails server (for registration)

## License

MIT
