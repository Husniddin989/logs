const Docker = require('dockerode');
const path = require('path');
const { createApp } = require('./app');
const { createAuditLogger } = require('./audit');
const { loadConfig } = require('./config');
const { createUserStore } = require('./userStore');
const { createTokenService } = require('./tokens');
const { ensureAdminAccount, removeUserWildcardGrants } = require('./bootstrap');

async function main() {
  const config = loadConfig(process.env);
  const audit = createAuditLogger({ file: config.auditLogFile });
  const userStore = createUserStore(path.join(config.dataDir, 'users.json'));

  const bootstrap = await ensureAdminAccount(userStore, config.admin);
  for (const username of bootstrap.disabled) {
    audit.log('system.account_password_disabled', { outcome: 'success', reason: 'published_default_password', target: { username } });
  }
  if (bootstrap.created || bootstrap.reset) {
    audit.log('system.admin_bootstrap', {
      outcome: 'success', target: { username: config.admin.username }, action: bootstrap.created ? 'created' : 'reset'
    });
  }
  for (const username of removeUserWildcardGrants(userStore)) {
    audit.log('system.wildcard_grant_removed', { outcome: 'success', target: { username } });
  }

  const tokens = createTokenService({
    secret: config.jwt.secret,
    accessTtlSeconds: config.jwt.accessTtlSeconds,
    sessionMaxAgeSeconds: config.jwt.sessionMaxAgeSeconds,
    revocationFile: path.join(config.dataDir, 'revoked-tokens.json')
  });

  const docker = new Docker({ socketPath: config.dockerSocket });
  const { server } = createApp({ docker, userStore, tokens, audit, trustProxy: config.trustProxy });

  server.listen(config.port, () => {
    console.log(`Docker Log Viewer API running on port ${config.port}`);
    console.log(`WebSocket server ready for connections`);
  });
}

main().catch(error => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
