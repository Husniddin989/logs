const Docker = require('dockerode');
const path = require('path');
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { createUserStore } = require('./userStore');
const { ensureAdminAccount } = require('./bootstrap');

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'docker-log-viewer-secret-key-change-in-production';

async function main() {
  const config = loadConfig(process.env);
  const userStore = createUserStore(path.join(config.dataDir, 'users.json'));
  await ensureAdminAccount(userStore, config.admin);

  const docker = new Docker({ socketPath: config.dockerSocket });
  const { server } = createApp({ docker, userStore, jwtSecret: JWT_SECRET });

  server.listen(config.port, () => {
    console.log(`Docker Log Viewer API running on port ${config.port}`);
    console.log(`WebSocket server ready for connections`);
  });
}

main().catch(error => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
