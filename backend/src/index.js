const Docker = require('dockerode');
const path = require('path');
const { createApp } = require('./app');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'docker-log-viewer-secret-key-change-in-production';

// Users data file path
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

const { server } = createApp({ docker, usersFile: USERS_FILE, jwtSecret: JWT_SECRET });

const PORT = process.env.PORT || 2001;
server.listen(PORT, () => {
  console.log(`Docker Log Viewer API running on port ${PORT}`);
  console.log(`WebSocket server ready for connections`);
  console.log(`Default admin: admin / admin123`);
});
