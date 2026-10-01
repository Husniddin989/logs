const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const http = require('http');
const proxyaddr = require('proxy-addr');
const WebSocket = require('ws');
const { createAuditLogger } = require('./audit');
const { createLoginThrottle } = require('./loginThrottle');
const { parseDockerLogs, demuxDockerStream, framesToLogLines } = require('./dockerLogs');
const { validatePassword, hashPassword, verifyPassword } = require('./passwords');
const { TokenError, PASSWORD_CHANGE_SCOPE } = require('./tokens');
const {
  applySettingsUpdate,
  publicSettings,
  validateBotToken,
  validateChatId,
  normalizeService
} = require('./alertSettings');
const { serviceCheck, DEFAULT_THRESHOLDS, DEFAULT_TEMPLATE, TEMPLATE_PLACEHOLDERS } = require('./alerting');
const {
  isValidContainerRef,
  canAccessContainer,
  normalizeAllowedContainers,
  validateUsername,
  validateRole
} = require('./access');

// Invalidates every token issued to the user so far
function bumpTokenVersion(user) {
  user.tokenVersion = (user.tokenVersion || 0) + 1;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    allowedContainers: user.allowedContainers,
    mustChangePassword: Boolean(user.mustChangePassword)
  };
}

function containerIdentity(summary) {
  return { id: summary.Id, name: (summary.Names?.[0] || '').replace(/^\//, '') };
}

function actorOf(user) {
  return user ? { id: user.id, username: user.username } : undefined;
}

function createApp({
  docker,
  userStore,
  tokens,
  audit = createAuditLogger(),
  loginThrottle = createLoginThrottle(),
  trustProxy = 'loopback, linklocal, uniquelocal',
  corsOrigins = [],
  // { store, service } for Telegram alerts; routes are only added when given
  alerts = null,
  wsRevalidateIntervalMs = 30 * 1000,
  wsAuthTimeoutMs = 10 * 1000
}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });

  // The frontend is served from the same origin as the API (nginx proxies
  // /api and /ws to the backend), so cross-origin requests are not needed.
  // By default no CORS headers are sent, which limits the browser API to the
  // app's own origin. Set CORS_ORIGINS only if a separate frontend origin
  // must call the API.
  const allowedOrigins = new Set(corsOrigins);
  const corsOptions = allowedOrigins.size === 0
    ? { origin: false }
    : {
        origin(origin, callback) {
          // Non-browser clients (curl, same-origin) send no Origin header
          callback(null, !origin || allowedOrigins.has(origin));
        }
      };

  // Do not advertise the framework
  app.disable('x-powered-by');

  // Client IPs in audit entries come from X-Forwarded-For only across trusted
  // proxy hops (see TRUST_PROXY)
  app.set('trust proxy', trustProxy);
  const isTrustedProxy = app.get('trust proxy fn');

  function requestContext(req) {
    return {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      method: req.method,
      path: req.originalUrl.split('?')[0]
    };
  }

  function loadUsers() {
    return userStore.load();
  }

  function saveUsers(data) {
    userStore.save(data);
  }

  app.use(cors(corsOptions));
  app.use(express.json({ limit: '1mb' }));

  // Return JSON (not Express's default HTML page) for malformed request bodies
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large' });
    }
    return next(err);
  });

  // ================== AUTH MIDDLEWARE ==================

  // Verifies a token and loads its user fresh from the store, so role,
  // container grants and deletions take effect immediately. Shared by the
  // REST middleware and the WebSocket. Returns { user, claims } or
  // { status, error, reason, code? }. Throws only if the user store is
  // unreadable.
  function authenticateToken(token, { allowPasswordChange = false } = {}) {
    if (typeof token !== 'string' || !token) {
      return { status: 401, error: 'No token provided', reason: 'missing' };
    }

    let claims;
    try {
      claims = tokens.verify(token);
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      return {
        status: 401,
        error: error.reason === 'revoked' ? 'Token revoked' : 'Invalid token',
        reason: error.reason
      };
    }

    const user = loadUsers().users.find(u => u.id === claims.sub);
    if (!user) {
      return { status: 401, error: 'User not found', reason: 'user_not_found', subject: claims.sub };
    }
    if ((user.tokenVersion || 0) !== claims.ver) {
      return { status: 401, error: 'Token revoked', reason: 'token_version', subject: claims.sub };
    }

    const passwordChangePending = claims.scope === PASSWORD_CHANGE_SCOPE || user.mustChangePassword;
    if (passwordChangePending && !allowPasswordChange) {
      return {
        status: 403,
        error: 'Password change required',
        code: 'PASSWORD_CHANGE_REQUIRED',
        reason: 'password_change_required'
      };
    }

    return { user, claims };
  }

  // A user who still has to replace an initial/reset password may only reach
  // routes created with { allowPasswordChange: true }.
  function requireAuth({ allowPasswordChange = false } = {}) {
    return (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        audit.log('auth.token_rejected', { outcome: 'failure', reason: 'missing', ...requestContext(req) });
        return res.status(401).json({ error: 'No token provided' });
      }

      let result;
      try {
        result = authenticateToken(authHeader.slice('Bearer '.length), { allowPasswordChange });
      } catch (error) {
        console.error('Error loading users:', error);
        return res.status(500).json({ error: 'User store unavailable' });
      }

      if (!result.user) {
        if (result.code !== 'PASSWORD_CHANGE_REQUIRED') {
          audit.log('auth.token_rejected', {
            outcome: 'failure',
            reason: result.reason,
            subject: result.subject,
            ...requestContext(req)
          });
        }
        return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
      }

      req.user = result.user;
      req.tokenClaims = result.claims;
      next();
    };
  }

  const authMiddleware = requireAuth();

  // After an await, re-check against freshly loaded data that the requesting
  // admin was not demoted, deleted or signed out in the meantime
  function isStillAdmin(data, req) {
    const actor = data.users.find(u => u.id === req.user.id);
    return Boolean(actor && actor.role === 'admin' && (actor.tokenVersion || 0) === req.tokenClaims.ver);
  }

  function adminMiddleware(req, res, next) {
    if (req.user.role !== 'admin') {
      audit.log('access.denied', {
        outcome: 'denied',
        reason: 'admin_required',
        actor: actorOf(req.user),
        ...requestContext(req)
      });
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  }

  // Resolves a client-supplied container reference to the container's
  // canonical identity and checks the user's grant against it. Non-admins get
  // the same 403 for "missing" and "forbidden" so they cannot probe for
  // container names. Returns { container } or { status, error }.
  async function authorizeContainer(user, ref) {
    if (!isValidContainerRef(ref)) {
      return { status: 400, error: 'Invalid container id' };
    }

    let container;
    try {
      const info = await docker.getContainer(ref).inspect();
      container = { id: info.Id, name: (info.Name || '').replace(/^\//, '') };
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }

    if (!container) {
      return user.role === 'admin'
        ? { status: 404, error: 'Container not found' }
        : { status: 403, error: 'Access denied to this container' };
    }
    if (!canAccessContainer(user, container)) {
      return { status: 403, error: 'Access denied to this container' };
    }
    return { container };
  }

  // ================== AUTH ENDPOINTS ==================

  // Per-process key: failed attempts against unknown usernames can be
  // correlated without writing the typed value (often a password) to the log
  const usernameDigestKey = crypto.randomBytes(32);
  const loginSubject = (username, user) => (user
    ? { username: user.username }
    : { usernameDigest: crypto.createHmac('sha256', usernameDigestKey).update(username).digest('hex').slice(0, 16) });

  // Login
  app.post('/api/auth/login', async (req, res) => {
    const ctx = requestContext(req);
    let attempt = null;
    try {
      const { username, password } = req.body || {};

      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password ||
          username.length > 128 || password.length > 1024) {
        audit.log('auth.login', { outcome: 'failure', reason: 'missing_fields', ...ctx });
        return res.status(400).json({ error: 'Username and password required' });
      }

      const { users } = loadUsers();
      const user = users.find(u => u.username === username);
      const subject = loginSubject(username, user);

      attempt = loginThrottle.begin(username, req.ip);
      if (attempt.retryAfter) {
        audit.log('auth.login', { outcome: 'failure', reason: 'rate_limited', ...subject, ...ctx });
        res.set('Retry-After', String(attempt.retryAfter));
        return res.status(429).json({
          error: `Too many failed login attempts. Try again in ${Math.ceil(attempt.retryAfter / 60)} minute(s).`
        });
      }

      // verifyPassword also burns time for unknown users and disabled passwords
      const validPassword = await verifyPassword(password, user?.password);
      attempt.finish(Boolean(user && validPassword));
      if (!user || !validPassword) {
        const reason = !user ? 'unknown_user' : (!user.password ? 'password_disabled' : 'bad_password');
        audit.log('auth.login', { outcome: 'failure', reason, ...subject, ...ctx });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (user.mustChangePassword) {
        audit.log('auth.login', {
          outcome: 'success', actor: actorOf(user), passwordChangeRequired: true, ...ctx
        });
        return res.json({
          token: tokens.issuePasswordChange(user),
          mustChangePassword: true,
          user: publicUser(user)
        });
      }

      audit.log('auth.login', { outcome: 'success', actor: actorOf(user), ...ctx });
      res.json({
        token: tokens.issueSession(user),
        user: publicUser(user)
      });
    } catch (error) {
      if (attempt) attempt.finish();
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // Get current user
  app.get('/api/auth/me', requireAuth({ allowPasswordChange: true }), (req, res) => {
    res.json(publicUser(req.user));
  });

  // Exchange a still-valid access token for a fresh one. The session keeps
  // its original auth_time, so it can never outlive SESSION_MAX_AGE.
  app.post('/api/auth/refresh', authMiddleware, (req, res) => {
    if (tokens.sessionExpired(req.tokenClaims)) {
      audit.log('auth.refresh', {
        outcome: 'failure', reason: 'session_expired', actor: actorOf(req.user), ...requestContext(req)
      });
      return res.status(401).json({ error: 'Session expired' });
    }
    audit.log('auth.refresh', { outcome: 'success', actor: actorOf(req.user), ...requestContext(req) });
    res.json({
      token: tokens.issueSession(req.user, { authTime: req.tokenClaims.auth_time }),
      user: publicUser(req.user)
    });
  });

  // Revoke the presented token
  app.post('/api/auth/logout', requireAuth({ allowPasswordChange: true }), (req, res) => {
    try {
      tokens.revoke(req.tokenClaims);
      audit.log('auth.logout', { outcome: 'success', actor: actorOf(req.user), ...requestContext(req) });
      res.status(204).end();
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({ error: 'Logout failed' });
    }
  });

  // Revoke every token of the current user, on every device
  app.post('/api/auth/logout-all', requireAuth({ allowPasswordChange: true }), (req, res) => {
    try {
      const data = loadUsers();
      const user = data.users.find(u => u.id === req.user.id);
      bumpTokenVersion(user);
      saveUsers(data);
      audit.log('auth.logout_all', { outcome: 'success', actor: actorOf(req.user), ...requestContext(req) });
      res.status(204).end();
    } catch (error) {
      console.error('Logout-all error:', error);
      res.status(500).json({ error: 'Logout failed' });
    }
  });

  // Change own password. Also completes the forced change after first login.
  app.post('/api/auth/change-password', requireAuth({ allowPasswordChange: true }), async (req, res) => {
    const ctx = requestContext(req);
    const fail = (status, error, reason) => {
      audit.log('auth.password_change', { outcome: 'failure', reason, actor: actorOf(req.user), ...ctx });
      return res.status(status).json({ error });
    };

    try {
      const { currentPassword, newPassword } = req.body || {};
      // Throttled like logins, so a stolen session cannot guess the password
      const throttleKey = `change-password:${req.user.id}`;

      const attempt = loginThrottle.begin(throttleKey, req.ip);
      if (attempt.retryAfter) {
        res.set('Retry-After', String(attempt.retryAfter));
        return fail(429, `Too many failed attempts. Try again in ${Math.ceil(attempt.retryAfter / 60)} minute(s).`, 'rate_limited');
      }

      const currentOk = await verifyPassword(currentPassword, req.user.password).catch(() => false);
      attempt.finish(currentOk);
      if (!currentOk) {
        return fail(400, 'Current password is incorrect', 'bad_current_password');
      }

      const problem = validatePassword(newPassword, { username: req.user.username });
      if (problem) {
        return fail(400, problem, 'policy');
      }
      if (newPassword === currentPassword) {
        return fail(400, 'New password must differ from the current one', 'unchanged');
      }

      const newHash = await hashPassword(newPassword);

      // No await between loading and saving the store: a concurrent request
      // (admin delete, revoke, reset) must not be overwritten by stale data
      const data = loadUsers();
      const user = data.users.find(u => u.id === req.user.id);
      if (!user || (user.tokenVersion || 0) !== req.tokenClaims.ver) {
        return fail(401, 'Session is no longer valid', 'session_revoked');
      }
      if (user.password !== req.user.password) {
        return fail(409, 'The password was changed in the meantime. Please sign in again.', 'conflict');
      }

      user.password = newHash;
      user.mustChangePassword = false;
      user.passwordChangedAt = new Date().toISOString();
      // Sign out every other session; the caller gets a fresh token below
      bumpTokenVersion(user);
      saveUsers(data);

      audit.log('auth.password_change', { outcome: 'success', actor: actorOf(user), ...ctx });
      res.json({ token: tokens.issueSession(user), user: publicUser(user) });
    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({ error: 'Failed to change password' });
    }
  });

  // ================== USER MANAGEMENT (Admin only) ==================

  // Get all users
  app.get('/api/users', authMiddleware, adminMiddleware, (req, res) => {
    const { users } = loadUsers();
    res.json(users.map(u => ({ ...publicUser(u), passwordDisabled: !u.password })));
  });

  // Create user. The admin-chosen password is temporary: the user has to
  // replace it at first login.
  app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { username, password, role = 'user', allowedContainers = [] } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
      }

      const grants = normalizeAllowedContainers(allowedContainers, role);
      const problem = validateUsername(username) || validateRole(role) || grants.error ||
        validatePassword(password, { username });
      if (problem) {
        return res.status(400).json({ error: problem });
      }

      if (loadUsers().users.some(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
      }

      const passwordHash = await hashPassword(password);

      // Re-read after the await and save without awaiting in between, so a
      // concurrent change to the store is not overwritten
      const data = loadUsers();
      if (!isStillAdmin(data, req)) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      if (data.users.some(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
      }

      const newUser = {
        id: crypto.randomUUID(),
        username,
        password: passwordHash,
        role,
        allowedContainers: grants.value,
        mustChangePassword: true
      };

      data.users.push(newUser);
      saveUsers(data);

      audit.log('admin.user_create', {
        outcome: 'success',
        actor: actorOf(req.user),
        target: actorOf(newUser),
        role: newUser.role,
        allowedContainers: newUser.allowedContainers,
        ...requestContext(req)
      });
      res.status(201).json(publicUser(newUser));
    } catch (error) {
      console.error('Create user error:', error);
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  // Update user
  app.put('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { username, password, role, allowedContainers } = req.body || {};

      // Hash before touching the store: nothing may be awaited between
      // loading and saving it, or concurrent changes would be overwritten
      let passwordHash = null;
      if (password) {
        const snapshot = loadUsers().users.find(u => u.id === id);
        if (!snapshot) {
          return res.status(404).json({ error: 'User not found' });
        }
        if (snapshot.id === req.user.id) {
          return res.status(400).json({ error: 'Use "Change password" to change your own password' });
        }
        const passwordProblem = validatePassword(password, { username: username || snapshot.username });
        if (passwordProblem) {
          return res.status(400).json({ error: passwordProblem });
        }
        passwordHash = await hashPassword(password);
      }

      const data = loadUsers();
      if (passwordHash && !isStillAdmin(data, req)) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      const userIndex = data.users.findIndex(u => u.id === id);

      if (userIndex === -1) {
        return res.status(404).json({ error: 'User not found' });
      }

      const target = data.users[userIndex];
      const nextRole = role || target.role;
      const grants = normalizeAllowedContainers(
        allowedContainers !== undefined ? allowedContainers : (role ? target.allowedContainers : undefined),
        nextRole
      );

      // Legacy accounts may predate the username rules: only a new name is validated
      const problem = (username !== undefined && username !== target.username && validateUsername(username)) ||
        (role !== undefined && validateRole(role)) ||
        grants.error;
      if (problem) {
        return res.status(400).json({ error: problem });
      }

      if (username && username !== target.username && data.users.some(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
      }

      if (target.role === 'admin' && nextRole !== 'admin' &&
          data.users.filter(u => u.role === 'admin').length <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last admin' });
      }

      if (password) {
        // Changing your own password must prove knowledge of the current one
        if (target.id === req.user.id) {
          return res.status(400).json({ error: 'Use "Change password" to change your own password' });
        }
        const passwordProblem = validatePassword(password, { username: username || target.username });
        if (passwordProblem) {
          return res.status(400).json({ error: passwordProblem });
        }
      }

      // What changed, for the audit log (never the password itself)
      const changes = {};
      if (username && username !== target.username) changes.username = { from: target.username, to: username };
      if (nextRole !== target.role) changes.role = { from: target.role, to: nextRole };
      if (grants.value !== undefined &&
          JSON.stringify(grants.value) !== JSON.stringify(target.allowedContainers || [])) {
        changes.allowedContainers = { from: target.allowedContainers || [], to: grants.value };
      }
      if (password) changes.passwordReset = true;

      if (username) target.username = username;
      // A password reset or role change signs the user out everywhere
      if (password || nextRole !== target.role) {
        bumpTokenVersion(target);
      }
      if (password) {
        target.password = passwordHash;
        target.mustChangePassword = true;
      }
      target.role = nextRole;
      if (grants.value !== undefined) target.allowedContainers = grants.value;

      saveUsers(data);

      audit.log('admin.user_update', {
        outcome: 'success',
        actor: actorOf(req.user),
        target: actorOf(target),
        changes,
        ...requestContext(req)
      });
      res.json(publicUser(target));
    } catch (error) {
      console.error('Update user error:', error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  // Delete user
  app.delete('/api/users/:id', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const { id } = req.params;
      const data = loadUsers();

      const userIndex = data.users.findIndex(u => u.id === id);
      if (userIndex === -1) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Prevent deleting the last admin
      const user = data.users[userIndex];
      if (user.role === 'admin') {
        const adminCount = data.users.filter(u => u.role === 'admin').length;
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot delete the last admin' });
        }
      }

      data.users.splice(userIndex, 1);
      saveUsers(data);

      audit.log('admin.user_delete', {
        outcome: 'success', actor: actorOf(req.user), target: actorOf(user), ...requestContext(req)
      });
      res.json({ message: 'User deleted' });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  // Sign a user out of every session (e.g. a lost laptop or a leaked token)
  app.post('/api/users/:id/revoke-sessions', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const data = loadUsers();
      const target = data.users.find(u => u.id === req.params.id);
      if (!target) {
        return res.status(404).json({ error: 'User not found' });
      }
      bumpTokenVersion(target);
      saveUsers(data);
      audit.log('admin.revoke_sessions', {
        outcome: 'success', actor: actorOf(req.user), target: actorOf(target), ...requestContext(req)
      });
      res.json({ message: 'Sessions revoked' });
    } catch (error) {
      console.error('Revoke sessions error:', error);
      res.status(500).json({ error: 'Failed to revoke sessions' });
    }
  });

  // ================== ALERT SETTINGS (Admin only) ==================

  if (alerts) {
    const { store: alertStore, service: alertService } = alerts;
    let lastTestAt = 0;
    let lastServiceTestAt = 0;

    // Saved settings with the message fields typed in the form (not saved
    // yet), validated like a save. Returns { settings } or { error }.
    const withMessageFields = (body = {}) => {
      const { settings } = alertStore.load();
      const fields = {};
      for (const key of ['hostname', 'serverIp', 'timezone', 'messageTemplate']) {
        if (body[key] !== undefined) fields[key] = body[key];
      }
      const result = applySettingsUpdate(settings, fields);
      return result.error ? { error: result.error } : { settings: result.settings };
    };

    app.get('/api/alerts/settings', authMiddleware, adminMiddleware, (req, res) => {
      try {
        const { settings, source } = alertStore.load();
        res.json({
          settings: publicSettings(settings),
          source,
          status: alertService.status(),
          // For the message format editor
          template: { default: DEFAULT_TEMPLATE, placeholders: TEMPLATE_PLACEHOLDERS }
        });
      } catch (error) {
        console.error('Alert settings load error:', error);
        res.status(500).json({ error: 'Failed to load alert settings' });
      }
    });

    app.put('/api/alerts/settings', authMiddleware, adminMiddleware, (req, res) => {
      try {
        const { settings: current } = alertStore.load();
        const result = applySettingsUpdate(current, req.body);
        if (result.error) {
          return res.status(400).json({ error: result.error });
        }

        alertStore.save(result.settings);
        alertService.apply(result.settings);

        // Field names only: the token value is never logged
        audit.log('admin.alert_settings_update', {
          outcome: 'success',
          actor: actorOf(req.user),
          changes: result.changes,
          enabled: result.settings.enabled,
          ...requestContext(req)
        });
        res.json({ settings: publicSettings(result.settings), source: 'saved', status: alertService.status() });
      } catch (error) {
        console.error('Alert settings save error:', error);
        res.status(500).json({ error: 'Failed to save alert settings' });
      }
    });

    // Test with the values typed in the form (not saved yet) or the saved ones
    app.post('/api/alerts/test', authMiddleware, adminMiddleware, async (req, res) => {
      try {
        const now = Date.now();
        if (now - lastTestAt < 3000) {
          return res.status(429).json({ error: 'Biroz kuting va qayta urinib ko‘ring' });
        }
        lastTestAt = now;

        const body = req.body || {};
        const { settings, error } = withMessageFields(body);
        if (error) {
          return res.status(400).json({ error });
        }
        const botToken = typeof body.botToken === 'string' && body.botToken.trim() ? body.botToken.trim() : settings.botToken;
        const chatId = body.chatId !== undefined && String(body.chatId).trim() ? String(body.chatId).trim() : settings.chatId;

        const problem = (!botToken && 'Bot token kiritilmagan') ||
          (!chatId && 'Chat ID kiritilmagan') ||
          validateBotToken(botToken) || validateChatId(chatId);
        if (problem) {
          return res.status(400).json({ error: problem });
        }

        const result = await alertService.sendTest({ botToken, chatId, settings });
        audit.log('admin.alert_test', {
          outcome: result.ok ? 'success' : 'failure',
          reason: result.ok ? undefined : result.error,
          actor: actorOf(req.user),
          ...requestContext(req)
        });
        if (!result.ok) {
          return res.status(502).json({ error: `Telegram xabarni qabul qilmadi: ${result.error}` });
        }
        res.json({ ok: true });
      } catch (error) {
        console.error('Alert test error:', error);
        res.status(500).json({ error: 'Failed to send test message' });
      }
    });

    // Send the full status report right now
    app.post('/api/alerts/report', authMiddleware, adminMiddleware, async (req, res) => {
      try {
        const result = await alertService.sendReport();
        if (!result.ok) return res.status(409).json({ error: result.error });
        res.json({ ok: true });
      } catch (error) {
        console.error('Alert report error:', error);
        res.status(500).json({ error: 'Failed to send report' });
      }
    });

    app.get('/api/alerts/status', authMiddleware, adminMiddleware, (req, res) => {
      res.json(alertService.status());
    });

    // How alerts will look with the template typed in the form
    app.post('/api/alerts/preview', authMiddleware, adminMiddleware, async (req, res) => {
      try {
        const { settings, error } = withMessageFields(req.body || {});
        if (error) {
          return res.status(400).json({ error });
        }
        res.json(await alertService.preview(settings));
      } catch (error) {
        console.error('Alert preview error:', error);
        res.status(500).json({ error: 'Failed to render preview' });
      }
    });

    // Probe one Postgres / Redis entry from the form. An empty password uses
    // the one saved for the same entry.
    app.post('/api/alerts/services/test', authMiddleware, adminMiddleware, async (req, res) => {
      try {
        const now = Date.now();
        if (now - lastServiceTestAt < 1000) {
          return res.status(429).json({ error: 'Biroz kuting va qayta urinib ko‘ring' });
        }
        lastServiceTestAt = now;

        const { settings } = alertStore.load();
        let service;
        try {
          service = normalizeService(req.body, settings.services || []);
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }

        const result = await alertService.testService(service);
        const check = serviceCheck(result, { ...DEFAULT_THRESHOLDS, ...settings.thresholds });
        audit.log('admin.alert_service_test', {
          outcome: result.ok ? 'success' : 'failure',
          service: { type: service.type, target: result.target },
          actor: actorOf(req.user),
          ...requestContext(req)
        });
        res.json({ ok: result.ok, level: check.level, detail: check.detail });
      } catch (error) {
        console.error('Alert service test error:', error);
        res.status(500).json({ error: 'Failed to test service' });
      }
    });
  }

  // ================== CONTAINER ENDPOINTS ==================

  // Get all containers (filtered by user access)
  app.get('/api/containers', authMiddleware, async (req, res) => {
    try {
      // Filter before gathering stats so nothing is computed for (or leaked
      // about) containers the user may not see
      const containers = (await docker.listContainers({ all: true, size: true }))
        .filter(c => canAccessContainer(req.user, containerIdentity(c)));

      // Get stats for running containers
      const statsPromises = containers.map(async (c) => {
        const baseInfo = {
          id: c.Id.substring(0, 12),
          fullId: c.Id,
          name: c.Names[0]?.replace('/', '') || 'unknown',
          image: c.Image,
          state: c.State,
          status: c.Status,
          created: new Date(c.Created * 1000).toISOString(),
          ports: c.Ports || [],
          sizeRw: c.SizeRw || 0,
          sizeRootFs: c.SizeRootFs || 0,
          cpuPercent: 0,
          memUsage: 0,
          memLimit: 0,
          memPercent: 0
        };

        // Get real-time stats for running containers
        if (c.State === 'running') {
          try {
            const container = docker.getContainer(c.Id);
            const stats = await new Promise((resolve, reject) => {
              container.stats({ stream: false }, (err, data) => {
                if (err) reject(err);
                else resolve(data);
              });
            });

            // Calculate CPU percentage
            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
            const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
            const cpuCount = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
            if (systemDelta > 0) {
              baseInfo.cpuPercent = ((cpuDelta / systemDelta) * cpuCount * 100).toFixed(2);
            }

            // Memory stats
            baseInfo.memUsage = stats.memory_stats.usage || 0;
            baseInfo.memLimit = stats.memory_stats.limit || 0;
            if (baseInfo.memLimit > 0) {
              baseInfo.memPercent = ((baseInfo.memUsage / baseInfo.memLimit) * 100).toFixed(2);
            }
          } catch (statsError) {
            console.error(`Stats error for ${c.Id}:`, statsError.message);
          }
        }

        return baseInfo;
      });

      res.json(await Promise.all(statsPromises));
    } catch (error) {
      console.error('Error fetching containers:', error);
      res.status(500).json({ error: 'Failed to fetch containers' });
    }
  });

  // Get container logs (with access check) - OPTIMIZED with pagination
  app.get('/api/containers/:id/logs', authMiddleware, async (req, res) => {
    try {
      const access = await authorizeContainer(req.user, req.params.id);
      if (!access.container) {
        if (access.status !== 404) {
          audit.log('access.denied', {
            outcome: 'denied',
            reason: access.status === 400 ? 'invalid_container_ref' : 'container_not_granted',
            actor: actorOf(req.user),
            containerRef: req.params.id,
            ...requestContext(req)
          });
        }
        return res.status(access.status).json({ error: access.error });
      }

      audit.log('logs.access', {
        outcome: 'success',
        channel: 'rest',
        actor: actorOf(req.user),
        container: access.container,
        ...requestContext(req)
      });

      // Use the canonical ID from here on, never the client's reference
      const container = docker.getContainer(access.container.id);

      const { tail, since, until, search, timeRange, page, limit } = req.query;

      // Pagination parameters
      const pageNum = Math.max(1, parseInt(page) || 1);
      const pageLimit = Math.min(Math.max(1, parseInt(limit) || 500), 2000); // Max 2000 logs per page

      const options = {
        stdout: true,
        stderr: true,
        timestamps: true
      };

      // Custom date range (since/until takes priority)
      for (const [key, value] of [['since', since], ['until', until]]) {
        if (!value) continue;
        const seconds = Math.floor(new Date(value).getTime() / 1000);
        if (!Number.isFinite(seconds)) {
          return res.status(400).json({ error: `Invalid ${key} date` });
        }
        options[key] = seconds;
      }

      // Time range filter (only if no custom date range)
      if (!since && !until && timeRange) {
        const now = Math.floor(Date.now() / 1000);
        switch (timeRange) {
          case '5m': options.since = now - 5 * 60; break;
          case '15m': options.since = now - 15 * 60; break;
          case '30m': options.since = now - 30 * 60; break;
          case '1h': options.since = now - 60 * 60; break;
          case '3h': options.since = now - 3 * 60 * 60; break;
          case '6h': options.since = now - 6 * 60 * 60; break;
          case '12h': options.since = now - 12 * 60 * 60; break;
          case '24h': options.since = now - 24 * 60 * 60; break;
          case '3d': options.since = now - 3 * 24 * 60 * 60; break;
          case '7d': options.since = now - 7 * 24 * 60 * 60; break;
          default: options.tail = 100;
        }
      } else if (!since && !until && tail) {
        options.tail = Math.min(Math.max(1, parseInt(tail) || 100), 10000);
      } else if (!since && !until) {
        options.tail = 100;
      }

      const logs = await container.logs(options);
      let logLines = parseDockerLogs(logs);

      // Filter by search if provided
      if (search) {
        const searchLower = search.toLowerCase();
        logLines = logLines.filter(log =>
          log.message.toLowerCase().includes(searchLower)
        );
      }

      // Calculate pagination: page 1 is the newest slice,
      // higher pages go further back in time
      const totalLogs = logLines.length;
      const totalPages = Math.max(1, Math.ceil(totalLogs / pageLimit));
      const endIndex = Math.max(0, totalLogs - (pageNum - 1) * pageLimit);
      const startIndex = Math.max(0, endIndex - pageLimit);

      // Get paginated logs (kept in chronological order within the page)
      const paginatedLogs = logLines.slice(startIndex, endIndex);

      // Return with pagination metadata
      res.json({
        logs: paginatedLogs,
        pagination: {
          page: pageNum,
          limit: pageLimit,
          totalLogs,
          totalPages,
          hasMore: startIndex > 0
        }
      });
    } catch (error) {
      console.error('Error fetching logs:', error);
      res.status(500).json({ error: 'Failed to fetch logs' });
    }
  });

  // ================== WEBSOCKET WITH AUTH ==================

  wss.on('connection', (ws, req) => {
    console.log('Client connected');
    let session = null; // { token, userId, username } once authenticated
    let current = null; // { stream, container } while streaming
    let subscribeSeq = 0;

    const wsContext = {
      channel: 'ws',
      ip: proxyaddr(req, isTrustedProxy),
      userAgent: req.headers['user-agent']
    };
    const sessionActor = () => (session ? { id: session.userId, username: session.username } : undefined);

    const send = (payload) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    const stopStream = () => {
      if (current) {
        current.stream.destroy();
        current = null;
      }
    };

    const endSession = (message, reason) => {
      audit.log('ws.session_ended', { outcome: 'failure', reason, actor: sessionActor(), ...wsContext });
      stopStream();
      session = null;
      send({ type: 'auth', status: 'failed', message });
      ws.close(4401, 'Unauthorized');
    };

    // Sockets that never authenticate are dropped
    const authTimer = setTimeout(() => {
      if (!session) ws.close(4401, 'Authentication timeout');
    }, wsAuthTimeoutMs);

    // Re-checks the session token and the grant for the container being
    // streamed. Returns the current user, or null after tearing down.
    const revalidate = () => {
      if (!session) return null;
      let result;
      try {
        result = authenticateToken(session.token);
      } catch (error) {
        console.error('Error loading users:', error);
        stopStream();
        send({ type: 'error', message: 'Request failed' });
        return null;
      }

      if (!result.user || result.user.id !== session.userId) {
        endSession(result.error || 'Session is no longer valid', result.reason);
        return null;
      }
      if (current && !canAccessContainer(result.user, current.container)) {
        audit.log('access.revoked', {
          outcome: 'denied', actor: actorOf(result.user), container: current.container, ...wsContext
        });
        stopStream();
        send({ type: 'error', code: 'ACCESS_REVOKED', message: 'Access to this container was revoked' });
      }
      return result.user;
    };

    // Grants can be revoked while a stream is open, so check periodically.
    // Grants may be by name, so the container's current name is re-read too:
    // a renamed container must not keep streaming to a user granted the old name.
    const recheckStream = async () => {
      const streamed = current;
      const user = revalidate();
      if (!user || !streamed || current !== streamed || user.role === 'admin') return;

      let fresh;
      try {
        const info = await docker.getContainer(streamed.container.id).inspect();
        fresh = { id: info.Id, name: (info.Name || '').replace(/^\//, '') };
      } catch (error) {
        return; // container gone: its log stream ends by itself
      }
      if (current !== streamed) return;
      if (canAccessContainer(user, fresh)) {
        streamed.container = fresh;
        return;
      }
      audit.log('access.revoked', { outcome: 'denied', actor: actorOf(user), container: fresh, ...wsContext });
      stopStream();
      send({ type: 'error', code: 'ACCESS_REVOKED', message: 'Access to this container was revoked' });
    };
    const revalidateTimer = setInterval(() => {
      if (current) recheckStream().catch(error => console.error('Stream re-check failed:', error));
    }, wsRevalidateIntervalMs);

    ws.on('message', async (message) => {
      let data;
      try {
        data = JSON.parse(message);
      } catch (error) {
        send({ type: 'error', message: 'Invalid message' });
        return;
      }
      if (!data || typeof data !== 'object') return;

      try {
        // Handle authentication
        if (data.action === 'auth') {
          const result = authenticateToken(data.token);
          if (!result.user) {
            audit.log('ws.auth', {
              outcome: 'failure', reason: result.reason, subject: result.subject, actor: sessionActor(), ...wsContext
            });
            stopStream();
            session = null;
            send({ type: 'auth', status: 'failed', message: result.error });
            return;
          }
          // An open socket cannot be handed over to a different user
          if (session && session.userId !== result.user.id) {
            endSession('Session user mismatch', 'user_mismatch');
            return;
          }
          // Re-authentication with a refreshed token is routine; log first auth only
          if (!session) {
            audit.log('ws.auth', { outcome: 'success', actor: actorOf(result.user), ...wsContext });
          }
          session = { token: data.token, userId: result.user.id, username: result.user.username };
          clearTimeout(authTimer);
          send({ type: 'auth', status: 'success' });
          return;
        }

        // Require authentication for other actions
        if (!session) {
          send({ type: 'error', message: 'Not authenticated' });
          return;
        }

        if (data.action === 'subscribe') {
          // Token and container grant are verified again on every subscribe
          const user = revalidate();
          if (!user) return;

          const access = await authorizeContainer(user, data.containerId);
          if (!access.container) {
            if (access.status !== 404) {
              audit.log('access.denied', {
                outcome: 'denied',
                reason: access.status === 400 ? 'invalid_container_ref' : 'container_not_granted',
                actor: actorOf(user),
                containerRef: typeof data.containerId === 'string' ? data.containerId : String(data.containerId),
                ...wsContext
              });
            }
            send({ type: 'error', message: access.error });
            return;
          }

          stopStream();
          const seq = ++subscribeSeq;
          const { container } = access;
          audit.log('logs.access', { outcome: 'success', actor: actorOf(user), container, ...wsContext });
          console.log(`Subscribing to container: ${container.id} (${container.name})`);
          const stream = await docker.getContainer(container.id).logs({
            follow: true,
            stdout: true,
            stderr: true,
            timestamps: true,
            tail: 50
          });

          // A newer subscribe/unsubscribe or a logout happened meanwhile
          if (seq !== subscribeSeq || !session || ws.readyState !== WebSocket.OPEN) {
            stream.destroy();
            return;
          }
          current = { stream, container };

          const filter = typeof data.filter === 'string' ? data.filter.slice(0, 500).toLowerCase() : '';

          // Frames can be split across chunks, so carry incomplete bytes over
          let pending = Buffer.alloc(0);
          stream.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            const { frames, rest } = demuxDockerStream(pending);
            pending = rest;
            framesToLogLines(frames).forEach(log => {
              if (filter && !log.message.toLowerCase().includes(filter)) return;
              send({ type: 'log', data: log });
            });
          });

          stream.on('error', (error) => {
            console.error('Stream error:', error);
            send({ type: 'error', message: 'Log stream error' });
          });

          stream.on('end', () => {
            console.log('Stream ended');
            send({ type: 'end', message: 'Log stream ended' });
          });

        } else if (data.action === 'unsubscribe') {
          subscribeSeq++;
          stopStream();
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
        send({ type: 'error', message: 'Request failed' });
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected');
      clearTimeout(authTimer);
      clearInterval(revalidateTimer);
      subscribeSeq++;
      stopStream();
    });
  });

  // ================== OTHER ENDPOINTS ==================

  // Health check (no auth required)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Docker info (auth required). Non-admins only get counts over the
  // containers they may see - no host-wide totals or daemon details.
  app.get('/api/docker/info', authMiddleware, async (req, res) => {
    try {
      if (req.user.role !== 'admin') {
        const visible = (await docker.listContainers({ all: true }))
          .filter(c => canAccessContainer(req.user, containerIdentity(c)));
        const running = visible.filter(c => c.State === 'running').length;
        const paused = visible.filter(c => c.State === 'paused').length;
        return res.json({
          containers: visible.length,
          containersRunning: running,
          containersPaused: paused,
          containersStopped: visible.length - running - paused
        });
      }

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

  return { app, server, wss };
}

module.exports = { createApp };
