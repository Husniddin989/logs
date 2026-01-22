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

# Edit .env and set a secure JWT_SECRET
nano .env
```

### 2. Start the Application

```bash
docker compose up -d --build
```

### 3. Access the Application

Open browser: `http://localhost:2000`

**Default credentials:**
- Username: `admin`
- Password: `admin123`

> Change the admin password after first login!

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | `docker-log-viewer-secret-change-me` | JWT signing key (MUST change!) |
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
| `user` | View only assigned containers |

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
| `/api/auth/login` | POST | No | Login, returns JWT |
| `/api/auth/me` | GET | Yes | Current user info |

### Users (Admin only)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/users` | GET | List all users |
| `/api/users` | POST | Create user |
| `/api/users/:id` | PUT | Update user |
| `/api/users/:id` | DELETE | Delete user |

### Containers

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/containers` | GET | List containers (filtered by access) |
| `/api/containers/:id/logs` | GET | Get container logs |
| `/api/docker/info` | GET | Docker system info |

### WebSocket

Connect to `/ws` for real-time log streaming:

```javascript
// Authenticate
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
│   │   ├── index.js          # Main API server
│   │   └── data/
│   │       └── users.json    # User storage
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

1. **Change JWT_SECRET** - Use a strong, random key in production
2. **Change admin password** - After first login, change the default password
3. **Docker socket access** - Backend has read-only access to Docker socket
4. **User data persistence** - Users are stored in a Docker volume (`users-data`)

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
