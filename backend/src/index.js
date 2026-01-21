const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const Docker = require('dockerode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

app.use(cors());
app.use(express.json());

// Store active log streams
const activeStreams = new Map();

// Get all running containers
app.get('/api/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const formatted = containers.map(c => ({
      id: c.Id.substring(0, 12),
      fullId: c.Id,
      name: c.Names[0]?.replace('/', '') || 'unknown',
      image: c.Image,
      state: c.State,
      status: c.Status,
      created: new Date(c.Created * 1000).toISOString()
    }));
    res.json(formatted);
  } catch (error) {
    console.error('Error fetching containers:', error);
    res.status(500).json({ error: 'Failed to fetch containers' });
  }
});

// Get container logs (non-streaming, with time filter)
app.get('/api/containers/:id/logs', async (req, res) => {
  try {
    const { id } = req.params;
    const { tail, since, until, search, timeRange } = req.query;

    const container = docker.getContainer(id);

    const options = {
      stdout: true,
      stderr: true,
      timestamps: true
    };

    // Time range filter (oxirgi X vaqt)
    if (timeRange) {
      const now = Math.floor(Date.now() / 1000);
      switch (timeRange) {
        case '5m':
          options.since = now - 5 * 60;
          break;
        case '15m':
          options.since = now - 15 * 60;
          break;
        case '1h':
          options.since = now - 60 * 60;
          break;
        case '6h':
          options.since = now - 6 * 60 * 60;
          break;
        case '24h':
          options.since = now - 24 * 60 * 60;
          break;
        case '3d':
          options.since = now - 3 * 24 * 60 * 60;
          break;
        case '5d':
          options.since = now - 5 * 24 * 60 * 60;
          break;
        default:
          options.tail = 100;
      }
    } else if (tail) {
      options.tail = parseInt(tail);
    } else {
      options.tail = 100; // default
    }

    // Custom since/until (ISO format)
    if (since && !timeRange) options.since = Math.floor(new Date(since).getTime() / 1000);
    if (until) options.until = Math.floor(new Date(until).getTime() / 1000);

    const logs = await container.logs(options);
    const logLines = parseDockerLogs(logs);

    // Filter by search term if provided
    let filteredLogs = logLines;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredLogs = logLines.filter(log =>
        log.message.toLowerCase().includes(searchLower)
      );
    }

    res.json(filteredLogs);
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Parse Docker log buffer with timestamps
function parseDockerLogs(buffer) {
  const lines = [];
  const str = buffer.toString('utf8');

  // Docker logs have 8-byte header for each line in multiplexed streams
  // Format: [stream_type(1)][0(3)][size(4)][payload]
  let offset = 0;
  const bufferData = Buffer.from(str, 'utf8');

  // Simple parsing - split by newlines and extract timestamps
  const rawLines = str.split('\n').filter(line => line.trim());

  rawLines.forEach((line, index) => {
    // Remove Docker stream header bytes if present (first 8 bytes of binary data)
    let cleanLine = line;
    if (line.charCodeAt(0) <= 2) {
      cleanLine = line.substring(8);
    }

    // Try to extract timestamp (format: 2024-01-15T10:30:45.123456789Z)
    const timestampMatch = cleanLine.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.?\d*Z?)\s*(.*)/);

    if (timestampMatch) {
      lines.push({
        id: `${Date.now()}-${index}`,
        timestamp: timestampMatch[1],
        message: timestampMatch[2] || '',
        stream: line.charCodeAt(0) === 2 ? 'stderr' : 'stdout'
      });
    } else if (cleanLine.trim()) {
      lines.push({
        id: `${Date.now()}-${index}`,
        timestamp: new Date().toISOString(),
        message: cleanLine,
        stream: 'stdout'
      });
    }
  });

  return lines;
}

// WebSocket connection for real-time log streaming
wss.on('connection', (ws) => {
  console.log('Client connected');
  let currentStream = null;
  let currentContainerId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.action === 'subscribe') {
        // Unsubscribe from previous container
        if (currentStream) {
          currentStream.destroy();
          activeStreams.delete(currentContainerId);
        }

        const containerId = data.containerId;
        currentContainerId = containerId;

        console.log(`Subscribing to container: ${containerId}`);

        const container = docker.getContainer(containerId);

        // Start streaming logs
        const stream = await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          timestamps: true,
          tail: 50
        });

        currentStream = stream;
        activeStreams.set(containerId, stream);

        stream.on('data', (chunk) => {
          const lines = parseDockerLogs(chunk);
          lines.forEach(log => {
            // Apply filter if set
            if (data.filter) {
              const filterLower = data.filter.toLowerCase();
              if (!log.message.toLowerCase().includes(filterLower)) {
                return;
              }
            }

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'log', data: log }));
            }
          });
        });

        stream.on('error', (error) => {
          console.error('Stream error:', error);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
          }
        });

        stream.on('end', () => {
          console.log('Stream ended');
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'end', message: 'Log stream ended' }));
          }
        });

      } else if (data.action === 'unsubscribe') {
        if (currentStream) {
          currentStream.destroy();
          activeStreams.delete(currentContainerId);
          currentStream = null;
          currentContainerId = null;
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (currentStream) {
      currentStream.destroy();
      activeStreams.delete(currentContainerId);
    }
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Docker info endpoint
app.get('/api/docker/info', async (req, res) => {
  try {
    const info = await docker.info();
    res.json({
      containers: info.Containers,
      containersRunning: info.ContainersRunning,
      containersPaused: info.ContainersPaused,
      containersStopped: info.ContainersStopped,
      images: info.Images,
      serverVersion: info.ServerVersion,
      operatingSystem: info.OperatingSystem
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get Docker info' });
  }
});

const PORT = process.env.PORT || 2001;
server.listen(PORT, () => {
  console.log(`🚀 Docker Log Viewer API running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for connections`);
});
