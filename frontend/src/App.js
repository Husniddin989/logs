import React, { useState, useEffect, useRef, useCallback } from 'react';
import ContainerList from './components/ContainerList';
import LogViewer from './components/LogViewer';
import LogFilters from './components/LogFilters';
import Login from './components/Login';
import ChangePassword from './components/ChangePassword';
import UserManagement from './components/UserManagement';
import { getLogLevel } from './utils/logLevel';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL || '';
const getWsUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
};

// Auth helper
const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    'Authorization': token ? `Bearer ${token}` : ''
  };
};

function App() {
  // Auth state
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);

  // App state
  const [containers, setContainers] = useState([]);
  const [selectedContainer, setSelectedContainer] = useState(null);
  const [logsMap, setLogsMap] = useState({});
  const [paginationMap, setPaginationMap] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [containerSearchTerm, setContainerSearchTerm] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [dockerInfo, setDockerInfo] = useState(null);
  const [levelFilter, setLevelFilter] = useState('all');
  const [timeRange, setTimeRange] = useState('live');
  const [customDateRange, setCustomDateRange] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const wsRef = useRef(null);
  const selectedContainerRef = useRef(null);
  const searchTermRef = useRef('');

  // Check for existing session on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');
    if (savedToken && savedUser) {
      try {
        const parsedUser = JSON.parse(savedUser);
        setToken(savedToken);
        setUser(parsedUser);
      } catch {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    }
  }, []);

  // Keep the latest search term available to the WebSocket handler
  // without making the connection depend on it
  useEffect(() => {
    searchTermRef.current = searchTerm;
  }, [searchTerm]);

  // Handle login
  const handleLogin = (userData, userToken) => {
    setUser(userData);
    setToken(userToken);
  };

  const handlePasswordChanged = (userData, userToken) => {
    setUser(userData);
    setToken(userToken);
    setShowChangePassword(false);
  };

  // Handle logout
  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    setToken(null);
    setShowChangePassword(false);
    setShowUserManagement(false);
    setContainers([]);
    setSelectedContainer(null);
    setLogsMap({});
    setPaginationMap({});
    if (wsRef.current) {
      wsRef.current.close();
    }
  }, []);

  // Returns true when the response was an auth failure that has been handled
  const handleAuthFailure = useCallback(async (response) => {
    if (response.status === 401) {
      handleLogout();
      return true;
    }
    if (response.status === 403) {
      const body = await response.clone().json().catch(() => ({}));
      if (body.code === 'PASSWORD_CHANGE_REQUIRED') {
        setUser(prev => {
          if (!prev) return prev;
          const next = { ...prev, mustChangePassword: true };
          localStorage.setItem('user', JSON.stringify(next));
          return next;
        });
        return true;
      }
    }
    return false;
  }, [handleLogout]);

  const mustChangePassword = Boolean(user?.mustChangePassword);

  // Fetch containers
  const fetchContainers = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_URL}/api/containers`, {
        headers: getAuthHeaders()
      });
      if (await handleAuthFailure(response)) return;
      const data = await response.json();
      if (Array.isArray(data)) setContainers(data);
    } catch (error) {
      console.error('Failed to fetch containers:', error);
    }
  }, [token, handleAuthFailure]);

  // Fetch Docker info
  const fetchDockerInfo = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_URL}/api/docker/info`, {
        headers: getAuthHeaders()
      });
      if (await handleAuthFailure(response)) return;
      const data = await response.json();
      setDockerInfo(data);
    } catch (error) {
      console.error('Failed to fetch Docker info:', error);
    }
  }, [token, handleAuthFailure]);

  // Initial data fetch
  useEffect(() => {
    if (token && !mustChangePassword) {
      fetchContainers();
      fetchDockerInfo();
      const interval = setInterval(fetchContainers, 10000);
      return () => clearInterval(interval);
    }
  }, [token, mustChangePassword, fetchContainers, fetchDockerInfo]);

  // Update ref when selectedContainer changes
  useEffect(() => {
    selectedContainerRef.current = selectedContainer;
  }, [selectedContainer]);

  // Fetch logs by time range with pagination support
  const fetchLogsByTimeRange = useCallback(async (container, range, customRange = null, page = 1, append = false) => {
    if (!container || range === 'live' || !token) return;

    setIsLoading(true);
    if (!append) {
      setIsStreaming(false);
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'unsubscribe' }));
    }

    try {
      const params = new URLSearchParams();

      if (customRange) {
        params.append('since', customRange.from.toISOString());
        params.append('until', customRange.to.toISOString());
      } else {
        params.append('timeRange', range);
      }

      // Pagination parameters
      params.append('page', page.toString());
      params.append('limit', '500');

      const response = await fetch(
        `${API_URL}/api/containers/${container.fullId}/logs?${params}`,
        { headers: getAuthHeaders() }
      );
      if (await handleAuthFailure(response)) return;
      const data = await response.json();

      // Handle paginated response
      if (data.logs && data.pagination) {
        setLogsMap(prev => ({
          ...prev,
          // Older pages are prepended so the list stays chronological
          [container.fullId]: append
            ? [...data.logs, ...(prev[container.fullId] || [])]
            : data.logs
        }));
        setPaginationMap(prev => ({
          ...prev,
          [container.fullId]: data.pagination
        }));
      } else {
        // Fallback for non-paginated response (backward compatibility)
        setLogsMap(prev => ({
          ...prev,
          [container.fullId]: Array.isArray(data) ? data : []
        }));
        setPaginationMap(prev => ({
          ...prev,
          [container.fullId]: null
        }));
      }
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    } finally {
      setIsLoading(false);
    }
  }, [token, handleAuthFailure]);

  // Load more logs (pagination)
  const handleLoadMore = useCallback(() => {
    if (!selectedContainer || isLoading) return;

    const currentPagination = paginationMap[selectedContainer.fullId];
    if (!currentPagination || !currentPagination.hasMore) return;

    const nextPage = currentPagination.page + 1;
    fetchLogsByTimeRange(
      selectedContainer,
      timeRange,
      customDateRange,
      nextPage,
      true // append mode
    );
  }, [selectedContainer, paginationMap, isLoading, timeRange, customDateRange, fetchLogsByTimeRange]);

  // WebSocket connection for live streaming
  useEffect(() => {
    if (!selectedContainer || timeRange !== 'live' || !token) return;

    let destroyed = false;
    let reconnectTimer = null;
    const reconnectDelay = 3000;

    const connect = () => {
      if (destroyed) return;

      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ action: 'auth', token }));
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);

        if (message.type === 'auth') {
          if (message.status === 'success') {
            setIsConnected(true);
            ws.send(JSON.stringify({
              action: 'subscribe',
              containerId: selectedContainer.fullId,
              filter: searchTermRef.current
            }));
            setIsStreaming(true);
          } else {
            console.error('WebSocket auth failed:', message.message);
            handleLogout();
          }
          return;
        }

        if (message.type === 'log') {
          const currentContainer = selectedContainerRef.current;
          if (currentContainer) {
            setLogsMap(prev => {
              const containerId = currentContainer.fullId;
              const currentLogs = prev[containerId] || [];
              const newLogs = [...currentLogs, message.data].slice(-2000);
              return { ...prev, [containerId]: newLogs };
            });
          }
        } else if (message.type === 'end') {
          // Stream tugadi, qayta ulaning
          setIsConnected(false);
          setIsStreaming(false);
          ws.close();
        } else if (message.type === 'error') {
          console.error('WebSocket error:', message.message);
          if (message.code === 'ACCESS_REVOKED') {
            setIsStreaming(false);
          }
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsStreaming(false);
        if (!destroyed) {
          reconnectTimer = setTimeout(connect, reconnectDelay);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setIsConnected(false);
      };
    };

    connect();

    return () => {
      destroyed = true;
      clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'unsubscribe' }));
        }
        ws.close();
      }
    };
  }, [selectedContainer, timeRange, token]);

  // Time range o'zgarganda loglarni yuklash
  useEffect(() => {
    if (selectedContainer && timeRange !== 'live') {
      fetchLogsByTimeRange(selectedContainer, timeRange);
    }
  }, [selectedContainer, timeRange, fetchLogsByTimeRange]);

  const currentLogs = selectedContainer ? (logsMap[selectedContainer.fullId] || []) : [];
  const currentPagination = selectedContainer ? paginationMap[selectedContainer.fullId] : null;

  const handleSelectContainer = (container) => {
    setSelectedContainer(container);
    setSearchTerm('');
    setLevelFilter('all');
    setTimeRange('live');
  };

  const handleTimeRangeChange = (range) => {
    setTimeRange(range);
    setCustomDateRange(null);
    if (selectedContainer) {
      setLogsMap(prev => ({
        ...prev,
        [selectedContainer.fullId]: []
      }));
      setPaginationMap(prev => ({
        ...prev,
        [selectedContainer.fullId]: null
      }));
    }
  };

  const handleCustomDateRangeChange = (range) => {
    setCustomDateRange(range);
    setTimeRange('custom');
    if (selectedContainer) {
      setLogsMap(prev => ({
        ...prev,
        [selectedContainer.fullId]: []
      }));
      setPaginationMap(prev => ({
        ...prev,
        [selectedContainer.fullId]: null
      }));
      fetchLogsByTimeRange(selectedContainer, 'custom', range);
    }
  };

  const handleSearch = async (term, doSearch = true) => {
    setSearchTerm(term);
    if (!selectedContainer || !token) return;

    // If not doing search (just updating input), return
    if (!doSearch) return;

    if (timeRange === 'live') {
      // Update the live stream filter on the existing connection
      // instead of reconnecting
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          action: 'subscribe',
          containerId: selectedContainer.fullId,
          filter: term
        }));
      }
      if (!term) return;
    }

    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (timeRange === 'custom' && customDateRange) {
        params.append('since', customDateRange.from.toISOString());
        params.append('until', customDateRange.to.toISOString());
      } else if (timeRange !== 'live') {
        params.append('timeRange', timeRange);
      } else {
        params.append('tail', '500');
      }
      if (term) params.append('search', term);
      params.append('limit', '500');

      const response = await fetch(
        `${API_URL}/api/containers/${selectedContainer.fullId}/logs?${params}`,
        { headers: getAuthHeaders() }
      );
      if (await handleAuthFailure(response)) return;
      const data = await response.json();

      // Handle paginated response
      if (data.logs && data.pagination) {
        setLogsMap(prev => ({
          ...prev,
          [selectedContainer.fullId]: data.logs
        }));
        setPaginationMap(prev => ({
          ...prev,
          [selectedContainer.fullId]: data.pagination
        }));
      } else {
        setLogsMap(prev => ({
          ...prev,
          [selectedContainer.fullId]: Array.isArray(data) ? data : []
        }));
      }
    } catch (error) {
      console.error('Failed to search logs:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredLogs = levelFilter === 'all'
    ? currentLogs
    : currentLogs.filter(log => getLogLevel(log) === levelFilter);

  const handleDownloadLogs = () => {
    if (!filteredLogs.length || !selectedContainer) return;

    const lines = filteredLogs.map(log => {
      const time = new Date(log.timestamp).toISOString();
      const stream = log.stream === 'stderr' ? 'ERR' : 'OUT';
      return `[${time}] [${stream}] ${log.message}`;
    }).join('\n');

    const blob = new Blob([lines], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedContainer.name}-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearLogs = () => {
    if (selectedContainer) {
      setLogsMap(prev => ({
        ...prev,
        [selectedContainer.fullId]: []
      }));
      setPaginationMap(prev => ({
        ...prev,
        [selectedContainer.fullId]: null
      }));
    }
  };

  const handleToggleStream = () => {
    if (timeRange !== 'live') {
      setTimeRange('live');
      return;
    }

    if (isStreaming && wsRef.current) {
      wsRef.current.send(JSON.stringify({ action: 'unsubscribe' }));
      setIsStreaming(false);
    } else if (selectedContainer && wsRef.current) {
      wsRef.current.send(JSON.stringify({
        action: 'subscribe',
        containerId: selectedContainer.fullId,
        filter: searchTerm
      }));
      setIsStreaming(true);
    }
  };

  // Show login if not authenticated
  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  if (mustChangePassword || showChangePassword) {
    return (
      <ChangePassword
        forced={mustChangePassword}
        onChanged={handlePasswordChanged}
        onCancel={mustChangePassword ? handleLogout : () => setShowChangePassword(false)}
        onSessionExpired={handleLogout}
      />
    );
  }

  // Show user management panel
  if (showUserManagement) {
    return (
      <UserManagement
        onBack={() => setShowUserManagement(false)}
        currentUser={user}
      />
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1 className="logo">Docker Log Viewer</h1>
          {dockerInfo && (
            <div className="docker-stats">
              <span className="stat">
                <span className="stat-icon">●</span>
                {dockerInfo.containersRunning} running
              </span>
              <span className="stat">
                {dockerInfo.containersStopped} stopped
              </span>
            </div>
          )}
        </div>
        <div className="header-right">
          <span className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
          <div className="user-menu">
            <span className="user-info">{user.username}</span>
            {user.role === 'admin' && (
              <button className="admin-btn" onClick={() => setShowUserManagement(true)}>
                Users
              </button>
            )}
            <button className="admin-btn" onClick={() => setShowChangePassword(true)}>
              Password
            </button>
            <button className="logout-btn" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>
      </header>

      <div className="main-content">
        <aside className="sidebar">
          <div className="sidebar-header">
            <h2>Containers</h2>
            <button className="refresh-btn" onClick={fetchContainers} title="Refresh containers">
              ↻
            </button>
          </div>
          <div className="container-search">
            <input
              type="text"
              className="container-search-input"
              placeholder="Search containers..."
              value={containerSearchTerm}
              onChange={(e) => setContainerSearchTerm(e.target.value)}
            />
            {containerSearchTerm && (
              <button
                className="search-clear-btn"
                onClick={() => setContainerSearchTerm('')}
                title="Clear search"
              >
                ×
              </button>
            )}
          </div>
          <ContainerList
            containers={containers}
            selectedContainer={selectedContainer}
            onSelect={handleSelectContainer}
            searchTerm={containerSearchTerm}
          />
        </aside>

        <main className="log-panel">
          {selectedContainer ? (
            <>
              <div className="log-header">
                <div className="container-info">
                  <h2>{selectedContainer.name}</h2>
                  <span className={`container-state ${selectedContainer.state}`}>
                    {selectedContainer.state}
                  </span>
                </div>

                <LogFilters
                  searchTerm={searchTerm}
                  onSearchChange={handleSearch}
                  timeRange={timeRange}
                  onTimeRangeChange={handleTimeRangeChange}
                  levelFilter={levelFilter}
                  onLevelFilterChange={setLevelFilter}
                  customDateRange={customDateRange}
                  onCustomDateRangeChange={handleCustomDateRangeChange}
                  isStreaming={isStreaming}
                  onToggleStream={handleToggleStream}
                  onClearLogs={handleClearLogs}
                  onDownloadLogs={handleDownloadLogs}
                  isLoading={isLoading}
                />
              </div>

              <LogViewer
                logs={filteredLogs}
                searchTerm={searchTerm}
                isStreaming={isStreaming}
                isLoading={isLoading}
                pagination={currentPagination}
                hasMore={currentPagination?.hasMore}
                onLoadMore={handleLoadMore}
              />

              <div className="log-footer">
                <span>
                  {filteredLogs.length} logs
                  {currentPagination && currentPagination.totalLogs > filteredLogs.length && (
                    <span className="total-logs"> / {currentPagination.totalLogs} total</span>
                  )}
                </span>
                {isStreaming && <span className="streaming-indicator">● Live</span>}
                {isLoading && <span className="loading-indicator">Loading...</span>}
                {timeRange !== 'live' && !isLoading && (
                  <span className="time-range-indicator">Showing: {timeRange}</span>
                )}
              </div>
            </>
          ) : (
            <div className="no-container-selected">
              <div className="placeholder-icon">📋</div>
              <h2>Select a Container</h2>
              <p>Choose a container from the sidebar to view its logs</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
