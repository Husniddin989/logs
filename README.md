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

If the admin password is lost, set `ADMIN_INITIAL_PASSWORD` again and remove the
`password` value of the admin in the `users-data` volume; the account is
re-initialised on the next start.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | – (required) | JWT signing key, 32+ random chars (`openssl rand -base64 48`). Changing it signs everyone out |
| `JWT_ACCESS_TTL` | `15m` | Access token lifetime; the UI refreshes it automatically |
| `SESSION_MAX_AGE` | `12h` | Absolute session length after login, refreshes included |
| `ADMIN_USERNAME` | `admin` | Username of the bootstrap admin account |
| `ADMIN_INITIAL_PASSWORD` | – | One-time admin password (min 12 chars), required on first start |
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

### Project Structure

```
docker-log-viewer/
├── backend/
│   ├── src/
│   │   ├── index.js          # Process entrypoint (config, admin bootstrap)
│   │   ├── app.js            # REST API + WebSocket server
│   │   └── data/             # Runtime data (users.json), not in git
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

## Security Notes

1. **JWT_SECRET** - Required, no default; weak or previously published values are refused. Tokens are HS256, 15 min, revocable (logout, password change, admin revoke)
2. **No default credentials** - The admin is created from `ADMIN_INITIAL_PASSWORD` and must pick a new password at first login
3. **Docker socket access** - The `:ro` mount does not make the Docker API read-only: the backend can call any Docker endpoint, so every container reference is validated and authorised server-side against the container's canonical ID/name before it reaches Docker
4. **User data persistence** - Users are stored in a Docker volume (`users-data`)
5. **Nothing secret in the frontend** - Every `REACT_APP_*` value and every file in `frontend/build` is public. Production builds have no source maps, and `npm run check-build` (run by the Dockerfile) fails on source maps, credential-like strings or secret-named `REACT_APP_*` variables

## Troubleshooting

### Containers not showing

- Ensure Docker socket is mounted: `/var/run/docker.sock:/var/run/docker.sock:ro`
- Check backend logs: `docker compose logs backend`

### Login issues

- Verify JWT_SECRET is set correctly
- Check browser console for errors
- Clear localStorage and try again

### WebSocket connection failed

- Ensure nginx is proxying `/ws` correctly
- Check if backend is running: `docker compose ps`

## License

MIT
