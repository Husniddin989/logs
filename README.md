# Docker Log Viewer

Real-time Docker container log viewer with user authentication and access control.

## Features

- Real-time log streaming via WebSocket
- User authentication (JWT-based)
- Role-based access control (Admin / User)
- Container-level permissions for users
- Log filtering by time range (5m, 15m, 1h, 24h, custom date)
- Log level filtering (Error, Warning, Info, Debug)
- Full-text search in logs
- Container stats monitoring (CPU, RAM, Uptime, Size)
- Dark theme UI

## Quick Start

### 1. Clone and Configure

```bash
# Clone the repository
git clone <repository-url>
cd docker-log-viewer

# Copy environment file
cp .env.example .env

# Edit .env: set a secure JWT_SECRET and a one-time ADMIN_INITIAL_PASSWORD
nano .env
```

### 2. Start the Application

```bash
docker compose up -d --build
```

### 3. Access the Application

Open browser: `http://localhost:2000`

There are no default credentials. On first start the backend creates the admin
account (`ADMIN_USERNAME`, default `admin`) with the password from
`ADMIN_INITIAL_PASSWORD` and refuses to start without it. At the first login
you are asked to choose a new password. After that, remove
`ADMIN_INITIAL_PASSWORD` from `.env`; it is ignored as long as an admin with a
working password exists.

If the admin password is lost, set `ADMIN_INITIAL_PASSWORD` again, set the
admin's `"password"` to `null` in `users.json` in the `users-data` volume and
restart the backend; the account is re-initialised with a forced password change.

Upgrading an existing installation: follow [SECURITY.md](SECURITY.md) (new
`JWT_SECRET`, one-time admin password, password rotation, compromise checks).

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | – (required) | JWT signing key, 32+ random chars (`openssl rand -base64 48`). Changing it signs everyone out |
| `JWT_ACCESS_TTL` | `15m` | Access token lifetime; the UI refreshes it automatically |
| `SESSION_MAX_AGE` | `12h` | Absolute session length after login, refreshes included |
| `ADMIN_USERNAME` | `admin` | Username of the bootstrap admin account |
| `ADMIN_INITIAL_PASSWORD` | – | One-time admin password (min 12 chars), required on first start |
| `AUDIT_LOG_FILE` | `/app/src/data/audit.log` (compose) | Append-only JSON-lines audit log; stdout only when unset |
| `TRUST_PROXY` | private networks | Proxies allowed to set `X-Forwarded-For` (Express syntax) |
| `FRONTEND_PORT` | `2000` | Web interface port |
| `NODE_ENV` | `production` | Node.js environment |

### Docker Compose Configuration

Edit `docker-compose.yml` to customize:

```yaml
services:
  frontend:
    ports:
      - "2000:80"  # Change 2000 to your preferred port
```

## User Management

### Roles

| Role | Permissions |
|------|-------------|
| `admin` | View all containers, manage users |
| `user` | View only explicitly assigned containers (the `*` wildcard is admin-only) |

### Adding Users (Admin Panel)

1. Login as admin
2. Click user icon (top-right) -> "User Management"
3. Click "+ Add User"
4. Fill username, password, role
5. Select allowed containers (for regular users)
6. Save

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Host                          │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────┐      ┌─────────────────────────┐  │
│  │    Frontend     │      │        Backend          │  │
│  │    (Nginx)      │─────>│       (Node.js)         │  │
│  │    Port 2000    │      │       Port 2001         │  │
│  └─────────────────┘      └───────────┬─────────────┘  │
│                                       │                 │
│                                       v                 │
│                           ┌─────────────────────────┐  │
│                           │     Docker Socket       │  │
│                           │  /var/run/docker.sock   │  │
│                           └─────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## API Endpoints

### Authentication

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/login` | POST | No | Login, returns a short-lived JWT (or a password-change-only token) |
| `/api/auth/me` | GET | Yes | Current user info |
| `/api/auth/refresh` | POST | Yes | New access token for the same session (until `SESSION_MAX_AGE`) |
| `/api/auth/change-password` | POST | Yes | Change own password; signs out other sessions |
| `/api/auth/logout` | POST | Yes | Revoke the presented token |
| `/api/auth/logout-all` | POST | Yes | Revoke every token of the current user |

### Users (Admin only)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/users` | GET | List all users |
| `/api/users` | POST | Create user |
| `/api/users/:id` | PUT | Update user |
| `/api/users/:id` | DELETE | Delete user |
| `/api/users/:id/revoke-sessions` | POST | Sign the user out everywhere |

### Containers

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/containers` | GET | List containers (filtered by access) |
| `/api/containers/:id/logs` | GET | Get container logs |
| `/api/docker/info` | GET | Docker system info |

### WebSocket

Connect to `/ws` for real-time log streaming:

```javascript
// Authenticate (send again with a refreshed token to keep the stream alive;
// the server re-checks token and container access periodically)
ws.send(JSON.stringify({ action: 'auth', token: 'your-jwt-token' }));

// Subscribe to container logs
ws.send(JSON.stringify({ action: 'subscribe', containerId: 'container-id' }));

// Unsubscribe
ws.send(JSON.stringify({ action: 'unsubscribe' }));
```

## Development

### Local Development

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend
cd frontend
npm install
npm start
```

### Tests and security checks

```bash
cd backend && npm test          # API, authorization, token and WebSocket tests
cd frontend && npm run build && npm run check-build   # no source maps / secrets in the bundle
```

CI (`.github/workflows/ci.yml`) runs the backend tests, the frontend build
check and a [gitleaks](https://github.com/gitleaks/gitleaks) scan of the whole
git history on every push and pull request. Rules live in `.gitleaks.toml`
(gitleaks defaults plus committed password hashes, runtime user data and
`.env` files); `.gitleaksignore` lists the only accepted historical finding
and why.

Enable the same scan before every commit, either with the pre-commit framework

```bash
pip install pre-commit && pre-commit install
```

or with the plain git hook (uses a local `gitleaks` or the pinned Docker image)

```bash
git config core.hooksPath .githooks
```

### Project Structure

```
docker-log-viewer/
├── backend/
│   ├── src/
│   │   ├── index.js          # Process entrypoint (config, admin bootstrap)
│   │   ├── app.js            # REST API + WebSocket server
│   │   ├── access.js         # Container reference validation and grants
│   │   ├── tokens.js         # JWT issue/verify/revoke
│   │   ├── audit.js          # JSON-lines audit log
│   │   ├── config.js, bootstrap.js, passwords.js, loginThrottle.js, userStore.js
│   │   └── data/             # Runtime data (users.json, audit.log), not in git
│   ├── test/                 # node:test suites (npm test)
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.js            # Main React component
│   │   ├── components/
│   │   │   ├── Login.js
│   │   │   ├── LogViewer.js
│   │   │   ├── LogFilters.js
│   │   │   ├── ContainerList.js
│   │   │   └── UserManagement.js
│   │   └── App.css
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml
├── .env.example
└── README.md
```

## Audit Log

Security events are written as one JSON object per line, tagged
`"type":"audit"`, to the backend's stdout and to `AUDIT_LOG_FILE`
(default `/app/src/data/audit.log` in the `users-data` volume, so it survives
container re-creation). Passwords, hashes and tokens are never logged.

| Event | When |
|-------|------|
| `auth.login` | every login attempt: `success`, or `failure` with `unknown_user` / `bad_password` / `password_disabled` / `missing_fields` / `rate_limited` |
| `auth.token_rejected` | a request with a missing, invalid, expired or revoked token |
| `auth.refresh`, `auth.logout`, `auth.logout_all`, `auth.password_change` | session lifecycle |
| `access.denied`, `access.revoked` | non-admin on an admin route, container not granted, malformed container reference, grant revoked mid-stream |
| `logs.access` | who opened which container's logs (REST or WebSocket) |
| `ws.auth`, `ws.session_ended` | WebSocket authentication and forced disconnects |
| `admin.user_create`, `admin.user_update`, `admin.user_delete`, `admin.revoke_sessions` | admin actions with actor, target and the changed fields |
| `system.*` | startup: admin bootstrap, disabled default passwords, removed `*` grants |

```bash
# Recent failed logins
docker exec docker-log-viewer-backend sh -c "grep '\"auth.login\"' /app/src/data/audit.log | grep failure | tail -50"
# Everything from one IP
docker exec docker-log-viewer-backend grep '"ip":"203.0.113.9"' /app/src/data/audit.log
```

Client IPs come from `X-Forwarded-For` only across trusted hops
(`TRUST_PROXY`, default: private networks), so a client cannot spoof them.
The file is not rotated by the app; rotate it with logrotate (`copytruncate`
or rename both work).

## Security Notes

1. **JWT_SECRET** - Required, no default; weak or previously published values are refused. Tokens are HS256, 15 min, revocable (logout, password change, admin revoke)
2. **No default credentials** - The admin is created from `ADMIN_INITIAL_PASSWORD` and must pick a new password at first login
3. **Docker socket access** - The `:ro` mount does not make the Docker API read-only: the backend can call any Docker endpoint, so every container reference is validated and authorised server-side against the container's canonical ID/name before it reaches Docker
4. **User data persistence** - Users are stored in a Docker volume (`users-data`)
5. **Brute-force protection** - 5 failed password checks per account and client IP (20 per IP) lock further attempts for 15 minutes
6. **Nothing secret in the frontend** - Every `REACT_APP_*` value and every file in `frontend/build` is public. Production builds have no source maps, and `npm run check-build` (run by the Dockerfile) fails on source maps, credential-like strings or secret-named `REACT_APP_*` variables

See [SECURITY.md](SECURITY.md) for the production upgrade and incident checklist.

## Troubleshooting

### Backend does not start

- `docker compose logs backend | grep startup` shows the reason: missing or weak
  `JWT_SECRET`, or no admin yet and no `ADMIN_INITIAL_PASSWORD`

### Containers not showing

- Ensure Docker socket is mounted: `/var/run/docker.sock:/var/run/docker.sock:ro`
- Check backend logs: `docker compose logs backend`

### Login issues

- "Too many failed login attempts": wait 15 minutes (see `auth.login` entries with `rate_limited` in the audit log)
- Sessions end after `SESSION_MAX_AGE` (12h) or when the laptop slept longer than `JWT_ACCESS_TTL`; just log in again
- Check browser console for errors
- Clear localStorage and try again

### WebSocket connection failed

- Ensure nginx is proxying `/ws` correctly
- Check if backend is running: `docker compose ps`

## License

MIT
