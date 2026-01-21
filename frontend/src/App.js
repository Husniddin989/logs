import React, { useState, useEffect, useRef, useCallback } from 'react';
import ContainerList from './components/ContainerList';
import LogViewer from './components/LogViewer';
import SearchBar from './components/SearchBar';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';
const WS_URL = process.env.REACT_APP_WS_URL || 'ws://localhost:3001';

function App() {
  const [containers, setContainers] = useState([]);
  const [selectedContainer, setSelectedContainer] = useState(null);
  const [logsMap, setLogsMap] = useState({}); // Container ID bo'yicha loglar saqlash
  const [searchTerm, setSearchTerm] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [dockerInfo, setDockerInfo] = useState(null);
  const [levelFilter, setLevelFilter] = useState('all');
  const [timeRange, setTimeRange] = useState('live'); // live, 5m, 15m, 1h, 6h, 24h, 3d, 5d
  const [isLoading, setIsLoading] = useState(false);
  const wsRef = useRef(null);
  const selectedContainerRef = useRef(null);

  // Fetch containers
  const fetchContainers = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/containers`);
      const data = await response.json();
      setContainers(data);
    } catch (error) {
      console.error('Failed to fetch containers:', error);
    }
  }, []);

  // Fetch Docker info
  const fetchDockerInfo = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/docker/info`);
      const data = await response.json();
      setDockerInfo(data);
    } catch (error) {
      console.error('Failed to fetch Docker info:', error);
    }
  }, []);

  // Initial data fetch
  useEffect(() => {
    fetchContainers();
    fetchDockerInfo();
    const interval = setInterval(fetchContainers, 10000);
    return () => clearInterval(interval);
  }, [fetchContainers, fetchDockerInfo]);

  // Update ref when selectedContainer changes
  useEffect(() => {
    selectedContainerRef.current = selectedContainer;
  }, [selectedContainer]);

  // Fetch logs by time range
  const fetchLogsByTimeRange = useCallback(async (container, range) => {
    if (!container || range === 'live') return;

    setIsLoading(true);
    setIsStreaming(false);

    // WebSocket streaming to'xtatish
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'unsubscribe' }));
    }

    try {
      const response = await fetch(
        `${API_URL}/api/containers/${container.fullId}/logs?timeRange=${range}`
      );
      const data = await response.json();
      setLogsMap(prev => ({
        ...prev,
        [container.fullId]: data
      }));
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // WebSocket connection for live streaming
  useEffect(() => {
    if (!selectedContainer || timeRange !== 'live') return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      ws.send(JSON.stringify({
        action: 'subscribe',
        containerId: selectedContainer.fullId,
        filter: searchTerm
      }));
      setIsStreaming(true);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
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
  }, [selectedContainer, timeRange]);

  // Time range o'zgarganda loglarni yuklash
  useEffect(() => {
    if (selectedContainer && timeRange !== 'live') {
      fetchLogsByTimeRange(selectedContainer, timeRange);
    }
  }, [selectedContainer, timeRange, fetchLogsByTimeRange]);

  // Hozirgi container uchun loglarni olish
  const currentLogs = selectedContainer ? (logsMap[selectedContainer.fullId] || []) : [];

  // Handle container selection
  const handleSelectContainer = (container) => {
    setSelectedContainer(container);
    setSearchTerm('');
    setLevelFilter('all');
    setTimeRange('live'); // Yangi container tanlanganda live rejimga qaytish
  };

  // Handle time range change
  const handleTimeRangeChange = (range) => {
    setTimeRange(range);
    if (selectedContainer) {
      // Eski loglarni tozalash
      setLogsMap(prev => ({
        ...prev,
        [selectedContainer.fullId]: []
      }));
    }
  };

  // Handle search
  const handleSearch = async (term) => {
    setSearchTerm(term);
    if (!selectedContainer) return;

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

    // Search with current time range
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (timeRange !== 'live') {
        params.append('timeRange', timeRange);
      } else {
        params.append('tail', '500');
      }
      if (term) params.append('search', term);

      const response = await fetch(
        `${API_URL}/api/containers/${selectedContainer.fullId}/logs?${params}`
      );
      const data = await response.json();
      setLogsMap(prev => ({
        ...prev,
        [selectedContainer.fullId]: data
      }));
    } catch (error) {
      console.error('Failed to search logs:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Filter logs by level
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

  // Clear logs for current container
  const handleClearLogs = () => {
    if (selectedContainer) {
      setLogsMap(prev => ({
        ...prev,
        [selectedContainer.fullId]: []
      }));
    }
  };

  // Pause/Resume streaming (only for live mode)
  const handleToggleStream = () => {
    if (timeRange !== 'live') {
      // Switch to live mode
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
          <ContainerList
            containers={containers}
            selectedContainer={selectedContainer}
            onSelect={handleSelectContainer}
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

                <SearchBar
                  value={searchTerm}
                  onChange={handleSearch}
                  placeholder="Search logs..."
                />

                <div className="log-controls">
                  <select
                    className="time-filter"
                    value={timeRange}
                    onChange={(e) => handleTimeRangeChange(e.target.value)}
                  >
                    <option value="live">Live</option>
                    <option value="5m">Last 5 min</option>
                    <option value="15m">Last 15 min</option>
                    <option value="1h">Last 1 hour</option>
                    <option value="6h">Last 6 hours</option>
                    <option value="24h">Last 24 hours</option>
                    <option value="3d">Last 3 days</option>
                    <option value="5d">Last 5 days</option>
                  </select>

                  <select
                    className="level-filter"
                    value={levelFilter}
                    onChange={(e) => setLevelFilter(e.target.value)}
                  >
                    <option value="all">All Levels</option>
                    <option value="error">Errors</option>
                    <option value="warn">Warnings</option>
                    <option value="info">Info</option>
                  </select>

                  <button
                    className={`stream-btn ${isStreaming ? 'streaming' : ''}`}
                    onClick={handleToggleStream}
                  >
                    {timeRange !== 'live' ? '▶ Go Live' : (isStreaming ? '⏸ Pause' : '▶ Stream')}
                  </button>

                  <button className="clear-btn" onClick={handleClearLogs}>
                    Clear
                  </button>
                </div>
              </div>

              <LogViewer
                logs={filteredLogs}
                searchTerm={searchTerm}
                isStreaming={isStreaming}
                isLoading={isLoading}
              />

              <div className="log-footer">
                <span>{filteredLogs.length} logs</span>
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
