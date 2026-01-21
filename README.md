# Docker Log Viewer

Real-time Docker container log viewer platformasi. ELK yoki Loki kabi murakkab tizimlardan farqli ravishda, bu platforma sodda va yengil.

## Features

- Real-time log streaming (WebSocket)
- Container tanlash va ko'rish
- Log qidirish va filterlash
- Log level filtering (Error, Warning, Info)
- Auto-scroll va manual scroll
- Running/Stopped containerlarni ko'rish

## Quick Start

### Docker Compose bilan

```bash
# Production
docker-compose up -d

# Browser: http://localhost:3000
```

### Development

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (boshqa terminalda)
cd frontend
npm install
npm start
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│    Frontend     │────▶│    Backend      │────▶│  Docker Socket  │
│   (React UI)    │ WS  │   (Node.js)     │     │                 │
│                 │◀────│                 │◀────│                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
     :3000                   :3001              /var/run/docker.sock
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/containers` | GET | Barcha containerlar ro'yxati |
| `/api/containers/:id/logs` | GET | Container loglarini olish |
| `/api/docker/info` | GET | Docker statistikasi |
| `/api/health` | GET | Health check |

### Query Parameters (logs)

- `tail` - Oxirgi N qator (default: 100)
- `search` - Qidiruv so'zi
- `since` - Vaqtdan boshlab (ISO format)
- `until` - Vaqtgacha (ISO format)

## WebSocket

WebSocket orqali real-time log streaming:

```javascript
const ws = new WebSocket('ws://localhost:3001');

// Subscribe
ws.send(JSON.stringify({
  action: 'subscribe',
  containerId: 'container_id',
  filter: 'error' // optional
}));

// Unsubscribe
ws.send(JSON.stringify({
  action: 'unsubscribe'
}));
```

## Environment Variables

### Backend
- `PORT` - Server port (default: 3001)

### Frontend
- `REACT_APP_API_URL` - Backend API URL
- `REACT_APP_WS_URL` - WebSocket URL

## License

MIT
