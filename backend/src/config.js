const path = require('path');

class ConfigError extends Error {}

function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 2001,
    dockerSocket: env.DOCKER_SOCKET || '/var/run/docker.sock',
    dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
    admin: {
      username: (env.ADMIN_USERNAME || 'admin').trim(),
      initialPassword: env.ADMIN_INITIAL_PASSWORD || null
    }
  };
}

module.exports = { loadConfig, ConfigError };
