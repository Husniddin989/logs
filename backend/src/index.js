const Docker = require('dockerode');
const path = require('path');
const { createApp } = require('./app');
const { createAuditLogger } = require('./audit');
const { loadConfig } = require('./config');
const { createUserStore } = require('./userStore');
const { createTokenService } = require('./tokens');
const { ensureAdminAccount, removeUserWildcardGrants } = require('./bootstrap');
const { createAlertSettingsStore, defaultsFromConfig } = require('./alertSettings');
const { createAlertService } = require('./alertService');

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

  // Alert settings are edited in the admin UI; env values are only defaults
  const alertStore = createAlertSettingsStore(
    path.join(config.dataDir, 'alert-settings.json'),
    defaultsFromConfig(config.alerts)
  );
  const alertService = createAlertService({
    docker,
    diskPath: config.alerts.diskPath,
    apiBase: config.alerts.telegram.apiBase
  });

  const { server } = createApp({
    docker, userStore, tokens, audit,
    trustProxy: config.trustProxy,
    corsOrigins: config.corsOrigins,
    alerts: { store: alertStore, service: alertService }
  });

  server.listen(config.port, () => {
    console.log(`Docker Log Viewer API running on port ${config.port}`);
    console.log(`WebSocket server ready for connections`);
  });

  alertService.apply(alertStore.load().settings, { announce: true });
}

main().catch(error => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
