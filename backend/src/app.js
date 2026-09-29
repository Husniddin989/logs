const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const http = require('http');
const proxyaddr = require('proxy-addr');
const WebSocket = require('ws');
const { createAuditLogger } = require('./audit');
const { parseDockerLogs, demuxDockerStream, framesToLogLines } = require('./dockerLogs');
const { validatePassword, hashPassword, verifyPassword } = require('./passwords');
const { TokenError, PASSWORD_CHANGE_SCOPE } = require('./tokens');
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
  trustProxy = 'loopback, linklocal, uniquelocal',
  wsRevalidateIntervalMs = 30 * 1000,
  wsAuthTimeoutMs = 10 * 1000
}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });

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

  app.use(cors());
  app.use(express.json());

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

  // Login
  app.post('/api/auth/login', async (req, res) => {
    const ctx = requestContext(req);
    try {
      const { username, password } = req.body || {};

      if (!username || !password) {
        audit.log('auth.login', { outcome: 'failure', reason: 'missing_fields', username, ...ctx });
        return res.status(400).json({ error: 'Username and password required' });
      }

      const { users } = loadUsers();
      const user = users.find(u => u.username === username);

      // verifyPassword also burns time for unknown users and disabled passwords
      const validPassword = await verifyPassword(password, user?.password);
      if (!user || !validPassword) {
        const reason = !user ? 'unknown_user' : (!user.password ? 'password_disabled' : 'bad_password');
        audit.log('auth.login', { outcome: 'failure', reason, username, ...ctx });
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

      if (!(await verifyPassword(currentPassword, req.user.password))) {
        return fail(400, 'Current password is incorrect', 'bad_current_password');
      }

      const problem = validatePassword(newPassword, { username: req.user.username });
      if (problem) {
        return fail(400, problem, 'policy');
      }
      if (newPassword === currentPassword) {
        return fail(400, 'New password must differ from the current one', 'unchanged');
      }

      const data = loadUsers();
      const user = data.users.find(u => u.id === req.user.id);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      user.password = await hashPassword(newPassword);
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

      const data = loadUsers();

      if (data.users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
      }

      const newUser = {
        id: crypto.randomUUID(),
        username,
        password: await hashPassword(password),
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

      const data = loadUsers();
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

      const problem = (username !== undefined && validateUsername(username)) ||
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
        target.password = await hashPassword(password);
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

    // Grants can be revoked while a stream is open, so check periodically
    const revalidateTimer = setInterval(() => {
      if (current) revalidate();
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
