# @radnine/claude-pilot-manager

Per-machine supervisor for `@radnine/claude-session-daemon` instances. Install it once on a machine, register your projects, and it handles starting, monitoring, restarting, and upgrading all your daemons from one place.

## Quick Start

```bash
# Install
npm install -g @radnine/claude-pilot-manager

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

## Configuration

All config lives in `~/.config/claude-pilot-manager/`:

```
~/.config/claude-pilot-manager/
├── config.yml        # Global settings
├── projects.yml      # Project registry
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
