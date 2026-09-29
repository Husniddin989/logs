const Docker = require('dockerode');
const path = require('path');
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { createUserStore } = require('./userStore');
const { createTokenService } = require('./tokens');
const { ensureAdminAccount, removeUserWildcardGrants } = require('./bootstrap');

async function main() {
  const config = loadConfig(process.env);
  const userStore = createUserStore(path.join(config.dataDir, 'users.json'));
  await ensureAdminAccount(userStore, config.admin);
  removeUserWildcardGrants(userStore);

  const tokens = createTokenService({
    secret: config.jwt.secret,
    accessTtlSeconds: config.jwt.accessTtlSeconds,
    sessionMaxAgeSeconds: config.jwt.sessionMaxAgeSeconds,
    revocationFile: path.join(config.dataDir, 'revoked-tokens.json')
  });

  const docker = new Docker({ socketPath: config.dockerSocket });
  const { server } = createApp({ docker, userStore, tokens });

  server.listen(config.port, () => {
    console.log(`Docker Log Viewer API running on port ${config.port}`);
    console.log(`WebSocket server ready for connections`);
  });
}

main().catch(error => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
