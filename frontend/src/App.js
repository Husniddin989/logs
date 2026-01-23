import React, { useState, useEffect, useRef, useCallback } from 'react';
import ContainerList from './components/ContainerList';
import LogViewer from './components/LogViewer';
import LogFilters from './components/LogFilters';
import Login from './components/Login';
import UserManagement from './components/UserManagement';
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

  // Check for existing session on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
    }
  }, []);

  // Handle login
  const handleLogin = (userData, userToken) => {
    setUser(userData);
    setToken(userToken);
  };

  // Handle logout
  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    setToken(null);
    setContainers([]);
    setSelectedContainer(null);
    setLogsMap({});
    setPaginationMap({});
    if (wsRef.current) {
      wsRef.current.close();
    }
  };

  // Fetch containers
  const fetchContainers = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_URL}/api/containers`, {
        headers: getAuthHeaders()
      });
      if (response.status === 401) {
        handleLogout();
        return;
      }
      const data = await response.json();
      setContainers(data);
    } catch (error) {
      console.error('Failed to fetch containers:', error);
    }
  }, [token]);

  // Fetch Docker info
  const fetchDockerInfo = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_URL}/api/docker/info`, {
        headers: getAuthHeaders()
      });
      if (response.status === 401) {
        handleLogout();
        return;
      }
      const data = await response.json();
      setDockerInfo(data);
    } catch (error) {
      console.error('Failed to fetch Docker info:', error);
    }
  }, [token]);

  // Initial data fetch
  useEffect(() => {
    if (token) {
      fetchContainers();
      fetchDockerInfo();
      const interval = setInterval(fetchContainers, 10000);
      return () => clearInterval(interval);
    }
  }, [token, fetchContainers, fetchDockerInfo]);

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
      if (response.status === 401) {
        handleLogout();
        return;
      }
      const data = await response.json();

      // Handle paginated response
      if (data.logs && data.pagination) {
        setLogsMap(prev => ({
          ...prev,
          [container.fullId]: append
            ? [...(prev[container.fullId] || []), ...data.logs]
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
  }, [token]);

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

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      // First authenticate
      ws.send(JSON.stringify({ action: 'auth', token }));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.type === 'auth') {
        if (message.status === 'success') {
          setIsConnected(true);
          // Now subscribe to container
          ws.send(JSON.stringify({
            action: 'subscribe',
            containerId: selectedContainer.fullId,
            filter: searchTerm
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
      } else if (message.type === 'error') {
        console.error('WebSocket error:', message.message);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setIsStreaming(false);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setIsConnected(false);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'unsubscribe' }));
      }
      ws.close();
    };
  }, [selectedContainer, timeRange, token, searchTerm]);

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

    if (!term && timeRange === 'live') {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          action: 'subscribe',
          containerId: selectedContainer.fullId,
          filter: ''
        }));
      }
      return;
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
      if (response.status === 401) {
        handleLogout();
        return;
      }
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

  const filteredLogs = currentLogs.filter(log => {
    if (levelFilter === 'all') return true;
    if (levelFilter === 'error') {
      return log.stream === 'stderr' ||
        log.message.toLowerCase().includes('error') ||
        log.message.toLowerCase().includes('err');
    }
    if (levelFilter === 'warn') {
      return log.message.toLowerCase().includes('warn') ||
        log.message.toLowerCase().includes('warning');
    }
    if (levelFilter === 'info') {
      return log.message.toLowerCase().includes('info');
    }
    return true;
  });

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
