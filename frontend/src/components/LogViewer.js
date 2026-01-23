import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import './LogViewer.css';

// Memoized log row component
const LogRow = React.memo(({ log, searchTerm, getLogLevel, formatTimestamp, highlightText }) => {
  if (!log) return null;

  return (
    <div className={`log-entry ${getLogLevel(log)}`}>
      <span className="log-timestamp">
        {formatTimestamp(log.timestamp)}
      </span>
      <span className={`log-stream ${log.stream}`}>
        {log.stream === 'stderr' ? 'ERR' : 'OUT'}
      </span>
      <span className="log-message">
        {highlightText(log.message, searchTerm)}
      </span>
    </div>
  );
});

// Group header component
const GroupHeader = React.memo(({ level, count, icon, isExpanded, onToggle }) => {
  const levelNames = {
    error: 'ERRORS',
    warn: 'WARNINGS',
    info: 'INFO',
    debug: 'DEBUG',
    default: 'OTHER'
  };

  return (
    <div className={`log-group-header ${level}`} onClick={onToggle}>
      <span className="group-toggle">{isExpanded ? '▼' : '▶'}</span>
      <span className="group-icon">{icon}</span>
      <span className="group-title">{levelNames[level]}</span>
      <span className="group-count">({count})</span>
    </div>
  );
});

// Time group header component
const TimeGroupHeader = React.memo(({ timeRange, count, isExpanded, onToggle }) => {
  return (
    <div className="time-group-header" onClick={onToggle}>
      <span className="time-toggle">{isExpanded ? '▼' : '▶'}</span>
      <span className="time-range">{timeRange}</span>
      <span className="time-count">{count} logs</span>
    </div>
  );
});

function LogViewer({ logs, searchTerm, isStreaming, isLoading, onLoadMore, hasMore, pagination }) {
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastLogCount = useRef(0);
  const [expandedLevels, setExpandedLevels] = useState({
    error: true,
    warn: true,
    info: true,
    debug: true,
    default: true
  });
  const [expandedTimeGroups, setExpandedTimeGroups] = useState({});

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (containerRef.current && autoScroll && logs.length > lastLogCount.current && logs.length > 0) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    lastLogCount.current = logs.length;
  }, [logs.length, autoScroll]);

  // Reset auto-scroll when logs are cleared
  useEffect(() => {
    if (logs.length === 0) {
      setAutoScroll(true);
    }
  }, [logs.length]);

  // Handle scroll events
  const handleScroll = useCallback((e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    const isAtTop = scrollTop < 100;

    setAutoScroll(isAtBottom);

    // Load more when scrolling to top
    if (isAtTop && hasMore && onLoadMore && !isLoading) {
      onLoadMore();
    }
  }, [hasMore, onLoadMore, isLoading]);

  // Scroll to bottom manually
  const scrollToBottom = useCallback(() => {
    if (containerRef.current && logs.length > 0) {
      setAutoScroll(true);
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.length]);

  // Highlight search term in log message
  const highlightText = useCallback((text, term) => {
    if (!term) return text;

    try {
      const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const parts = text.split(new RegExp(`(${escapedTerm})`, 'gi'));
      return parts.map((part, index) =>
        part.toLowerCase() === term.toLowerCase() ? (
          <mark key={index} className="highlight">{part}</mark>
        ) : (
          part
        )
      );
    } catch {
      return text;
    }
  }, []);

  // Get log level class
  const getLogLevel = useCallback((log) => {
    const msg = log.message.toLowerCase();
    if (log.stream === 'stderr' || msg.includes('error') || msg.includes('err]')) {
      return 'error';
    }
    if (msg.includes('warn') || msg.includes('warning')) {
      return 'warn';
    }
    if (msg.includes('debug')) {
      return 'debug';
    }
    if (msg.includes('info')) {
      return 'info';
    }
    return 'default';
  }, []);

  // Format timestamp
  const formatTimestamp = useCallback((timestamp) => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
      });
    } catch {
      return timestamp;
    }
  }, []);

  // Group logs by level and time
  const groupedLogs = useMemo(() => {
    const groups = {
      error: [],
      warn: [],
      info: [],
      debug: [],
      default: []
    };

    // First, group by level
    logs.forEach(log => {
      const level = getLogLevel(log);
      groups[level].push(log);
    });

    // Then, group each level by time intervals (5 minutes)
    const result = {};
    Object.keys(groups).forEach(level => {
      if (groups[level].length === 0) return;

      const timeGroups = {};
      groups[level].forEach(log => {
        try {
          const date = new Date(log.timestamp);
          // Round down to nearest 5 minutes
          const minutes = Math.floor(date.getMinutes() / 5) * 5;
          date.setMinutes(minutes, 0, 0);
          const timeKey = date.toISOString();

          if (!timeGroups[timeKey]) {
            timeGroups[timeKey] = [];
          }
          timeGroups[timeKey].push(log);
        } catch {
          // If timestamp parsing fails, use a default group
          if (!timeGroups['unknown']) {
            timeGroups['unknown'] = [];
          }
          timeGroups['unknown'].push(log);
        }
      });

      result[level] = timeGroups;
    });

    return result;
  }, [logs, getLogLevel]);

  // Toggle level group
  const toggleLevelGroup = useCallback((level) => {
    setExpandedLevels(prev => ({
      ...prev,
      [level]: !prev[level]
    }));
  }, []);

  // Toggle time group
  const toggleTimeGroup = useCallback((groupKey) => {
    setExpandedTimeGroups(prev => ({
      ...prev,
      [groupKey]: !prev[groupKey]
    }));
  }, []);

  // Format time range for display
  const formatTimeRange = useCallback((timeKey) => {
    if (timeKey === 'unknown') return 'Unknown Time';

    try {
      const startDate = new Date(timeKey);
      const endDate = new Date(startDate.getTime() + 5 * 60 * 1000); // +5 minutes

      const formatTime = (date) => {
        return date.toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit'
        });
      };

      return `${formatTime(startDate)} - ${formatTime(endDate)}`;
    } catch {
      return timeKey;
    }
  }, []);

  return (
    <div className="log-viewer">
      {isLoading && logs.length === 0 ? (
        <div className="no-logs">
          <div className="waiting-icon loading-spinner">⏳</div>
          <p>Loading logs...</p>
        </div>
      ) : logs.length === 0 ? (
        <div className="no-logs">
          {isStreaming ? (
            <>
              <div className="waiting-icon">⏳</div>
              <p>Waiting for logs...</p>
            </>
          ) : (
            <>
              <div className="waiting-icon">📭</div>
              <p>No logs to display</p>
            </>
          )}
        </div>
      ) : (
        <div className="log-entries-container">
          {/* Pagination info */}
          {pagination && (
            <div className="pagination-info">
              <span>Showing {logs.length} of {pagination.totalLogs} logs</span>
              {pagination.hasMore && (
                <button className="load-more-btn" onClick={onLoadMore} disabled={isLoading}>
                  {isLoading ? 'Loading...' : 'Load more'}
                </button>
              )}
            </div>
          )}

          {/* Loading indicator for pagination */}
          {isLoading && logs.length > 0 && (
            <div className="loading-more">
              Loading more logs...
            </div>
          )}

          {/* Scrollable log list with grouping */}
          <div
            ref={containerRef}
            className="log-scroll-container"
            onScroll={handleScroll}
          >
            {Object.keys(groupedLogs).map(level => {
              const timeGroups = groupedLogs[level];
              const totalCount = Object.values(timeGroups).reduce((sum, logs) => sum + logs.length, 0);

              if (totalCount === 0) return null;

              const levelIcons = {
                error: '🔴',
                warn: '🟡',
                info: '🔵',
                debug: '⚪',
                default: '⚫'
              };

              return (
                <div key={level} className="log-level-group">
                  <GroupHeader
                    level={level}
                    count={totalCount}
                    icon={levelIcons[level]}
                    isExpanded={expandedLevels[level]}
                    onToggle={() => toggleLevelGroup(level)}
                  />

                  {expandedLevels[level] && (
                    <div className="time-groups-container">
                      {Object.keys(timeGroups).sort((a, b) => {
                        // Sort time groups chronologically
                        if (a === 'unknown') return 1;
                        if (b === 'unknown') return -1;
                        return new Date(a) - new Date(b);
                      }).map(timeKey => {
                        const logsInGroup = timeGroups[timeKey];
                        const groupKey = `${level}-${timeKey}`;
                        const isTimeExpanded = expandedTimeGroups[groupKey] !== false; // Default expanded

                        return (
                          <div key={groupKey} className="time-group">
                            <TimeGroupHeader
                              timeRange={formatTimeRange(timeKey)}
                              count={logsInGroup.length}
                              isExpanded={isTimeExpanded}
                              onToggle={() => toggleTimeGroup(groupKey)}
                            />

                            {isTimeExpanded && (
                              <div className="time-group-logs">
                                {logsInGroup.map((log, index) => (
                                  <LogRow
                                    key={`${log.timestamp}-${index}`}
                                    log={log}
                                    searchTerm={searchTerm}
                                    getLogLevel={getLogLevel}
                                    formatTimestamp={formatTimestamp}
                                    highlightText={highlightText}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!autoScroll && logs.length > 0 && (
        <button
          className="scroll-to-bottom"
          onClick={scrollToBottom}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}

export default LogViewer;
