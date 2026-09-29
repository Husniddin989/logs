const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { parseDockerLogs, demuxDockerStream, framesToLogLines } = require('./dockerLogs');
const { validatePassword, hashPassword, verifyPassword } = require('./passwords');

const PASSWORD_CHANGE_SCOPE = 'password_change';

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    allowedContainers: user.allowedContainers,
    mustChangePassword: Boolean(user.mustChangePassword)
  };
}

function createApp({ docker, userStore, jwtSecret }) {
  const JWT_SECRET = jwtSecret;

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  function loadUsers() {
    return userStore.load();
  }

  function saveUsers(data) {
    userStore.save(data);
  }

  function signSessionToken(user) {
    return jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
  }

  // Only good for POST /api/auth/change-password
  function signPasswordChangeToken(user) {
    return jwt.sign(
      { userId: user.id, username: user.username, scope: PASSWORD_CHANGE_SCOPE },
      JWT_SECRET,
      { expiresIn: '10m' }
    );
  }

  app.use(cors());
  app.use(express.json());

  // Store active log streams
  const activeStreams = new Map();

  // ================== AUTH MIDDLEWARE ==================

  // A user who still has to replace an initial/reset password may only reach
  // routes created with { allowPasswordChange: true }.
  function requireAuth({ allowPasswordChange = false } = {}) {
    return (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
      }

      let decoded;
      try {
        decoded = jwt.verify(authHeader.slice('Bearer '.length), JWT_SECRET);
      } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      let user;
      try {
        user = loadUsers().users.find(u => u.id === decoded.userId);
      } catch (error) {
        console.error('Error loading users:', error);
        return res.status(500).json({ error: 'User store unavailable' });
      }

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      const passwordChangePending = decoded.scope === PASSWORD_CHANGE_SCOPE || user.mustChangePassword;
      if (passwordChangePending && !allowPasswordChange) {
        return res.status(403).json({ error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' });
      }

      req.user = user;
      next();
    };
  }

  const authMiddleware = requireAuth();

  function adminMiddleware(req, res, next) {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  }

  // Check if user has access to container
  function hasContainerAccess(user, containerIdOrName, containerName = null) {
    if (user.role === 'admin') return true;
    if (!user.allowedContainers || user.allowedContainers.length === 0) return false;
    if (user.allowedContainers.includes('*')) return true;

    // Check by container ID or name
    return user.allowedContainers.some(allowed => {
      // Exact match by name
      if (containerName && allowed === containerName) return true;
      // Exact match by ID or name parameter
      if (allowed === containerIdOrName) return true;
      // Partial ID match (short ID vs full ID)
      if (containerIdOrName.startsWith(allowed) || allowed.startsWith(containerIdOrName)) return true;
      return false;
    });
  }

  // ================== AUTH ENDPOINTS ==================

  // Login
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
      }

      const { users } = loadUsers();
      const user = users.find(u => u.username === username);

      // verifyPassword also burns time for unknown users and disabled passwords
      const validPassword = await verifyPassword(password, user?.password);
      if (!user || !validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (user.mustChangePassword) {
        return res.json({
          token: signPasswordChangeToken(user),
          mustChangePassword: true,
          user: publicUser(user)
        });
      }

      res.json({
        token: signSessionToken(user),
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

  // Change own password. Also completes the forced change after first login.
  app.post('/api/auth/change-password', requireAuth({ allowPasswordChange: true }), async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};

      if (!(await verifyPassword(currentPassword, req.user.password))) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }

      const problem = validatePassword(newPassword, { username: req.user.username });
      if (problem) {
        return res.status(400).json({ error: problem });
      }
      if (newPassword === currentPassword) {
        return res.status(400).json({ error: 'New password must differ from the current one' });
      }

      const data = loadUsers();
      const user = data.users.find(u => u.id === req.user.id);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      user.password = await hashPassword(newPassword);
      user.mustChangePassword = false;
      user.passwordChangedAt = new Date().toISOString();
      saveUsers(data);

      res.json({ token: signSessionToken(user), user: publicUser(user) });
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
      const { username, password, role, allowedContainers } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
      }

      const problem = validatePassword(password, { username });
      if (problem) {
        return res.status(400).json({ error: problem });
      }

      const data = loadUsers();

      if (data.users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
      }

      const newUser = {
        id: Date.now().toString(),
        username,
        password: await hashPassword(password),
        role: role || 'user',
        allowedContainers: allowedContainers || [],
        mustChangePassword: true
      };

      data.users.push(newUser);
      saveUsers(data);

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
      const { username, password, role, allowedContainers } = req.body;

      const data = loadUsers();
      const userIndex = data.users.findIndex(u => u.id === id);

      if (userIndex === -1) {
        return res.status(404).json({ error: 'User not found' });
      }

      const target = data.users[userIndex];

      if (password) {
        // Changing your own password must prove knowledge of the current one
        if (target.id === req.user.id) {
          return res.status(400).json({ error: 'Use "Change password" to change your own password' });
        }
        const problem = validatePassword(password, { username: username || target.username });
        if (problem) {
          return res.status(400).json({ error: problem });
        }
      }

      if (username) target.username = username;
      if (password) {
        target.password = await hashPassword(password);
        target.mustChangePassword = true;
      }
      if (role) target.role = role;
      if (allowedContainers !== undefined) target.allowedContainers = allowedContainers;

      saveUsers(data);

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

      res.json({ message: 'User deleted' });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  // ================== CONTAINER ENDPOINTS ==================

  // Get all containers (filtered by user access)
  app.get('/api/containers', authMiddleware, async (req, res) => {
    try {
      const containers = await docker.listContainers({ all: true, size: true });

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

      let formatted = await Promise.all(statsPromises);

      // Filter containers based on user access
      if (req.user.role !== 'admin' && !req.user.allowedContainers?.includes('*')) {
        formatted = formatted.filter(c => hasContainerAccess(req.user, c.fullId, c.name));
      }

      res.json(formatted);
    } catch (error) {
      console.error('Error fetching containers:', error);
      res.status(500).json({ error: 'Failed to fetch containers' });
    }
  });

  // Get container logs (with access check) - OPTIMIZED with pagination
  app.get('/api/containers/:id/logs', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const container = docker.getContainer(id);

      // Get container info to check access by name
      let containerName = null;
      try {
        const info = await container.inspect();
        containerName = info.Name?.replace('/', '') || null;
      } catch (e) {
        // Container might not exist
      }

      // Check access
      if (!hasContainerAccess(req.user, id, containerName)) {
        return res.status(403).json({ error: 'Access denied to this container' });
      }

      const { tail, since, until, search, timeRange, page, limit } = req.query;

      // Pagination parameters
      const pageNum = parseInt(page) || 1;
      const pageLimit = Math.min(parseInt(limit) || 500, 2000); // Max 2000 logs per page

      const options = {
        stdout: true,
        stderr: true,
        timestamps: true
      };

      // Custom date range (since/until takes priority)
      if (since) {
        options.since = Math.floor(new Date(since).getTime() / 1000);
      }
      if (until) {
        options.until = Math.floor(new Date(until).getTime() / 1000);
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
        options.tail = parseInt(tail);
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
    let currentStream = null;
    let currentContainerId = null;
    let authenticatedUser = null;

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        // Handle authentication
        if (data.action === 'auth') {
          try {
            const decoded = jwt.verify(data.token, JWT_SECRET);
            const { users } = loadUsers();
            const user = users.find(u => u.id === decoded.userId);

            if (!user) {
              authenticatedUser = null;
              ws.send(JSON.stringify({ type: 'auth', status: 'failed', message: 'User not found' }));
            } else if (decoded.scope === PASSWORD_CHANGE_SCOPE || user.mustChangePassword) {
              authenticatedUser = null;
              ws.send(JSON.stringify({ type: 'auth', status: 'failed', message: 'Password change required' }));
            } else {
              authenticatedUser = user;
              ws.send(JSON.stringify({ type: 'auth', status: 'success' }));
            }
          } catch (error) {
            authenticatedUser = null;
            ws.send(JSON.stringify({ type: 'auth', status: 'failed', message: 'Invalid token' }));
          }
          return;
        }

        // Require authentication for other actions
        if (!authenticatedUser) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
          return;
        }

        if (data.action === 'subscribe') {
          const containerId = data.containerId;
          const container = docker.getContainer(containerId);

          // Get container name for access check
          let containerName = null;
          try {
            const info = await container.inspect();
            containerName = info.Name?.replace('/', '') || null;
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Container not found' }));
            return;
          }

          // Check access
          if (!hasContainerAccess(authenticatedUser, containerId, containerName)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Access denied to this container' }));
            return;
          }

          // Unsubscribe from previous
          if (currentStream) {
            currentStream.destroy();
            activeStreams.delete(currentContainerId);
          }

          currentContainerId = containerId;
          console.log(`Subscribing to container: ${containerId} (${containerName})`);
          const stream = await container.logs({
            follow: true,
            stdout: true,
            stderr: true,
            timestamps: true,
            tail: 50
          });

          currentStream = stream;
          activeStreams.set(containerId, stream);

          // Frames can be split across chunks, so carry incomplete bytes over
          let pending = Buffer.alloc(0);
          stream.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            const { frames, rest } = demuxDockerStream(pending);
            pending = rest;
            const lines = framesToLogLines(frames);
            lines.forEach(log => {
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

  // ================== OTHER ENDPOINTS ==================

  // Health check (no auth required)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Docker info (auth required)
  app.get('/api/docker/info', authMiddleware, async (req, res) => {
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

  return { app, server, wss };
}

module.exports = { createApp };
