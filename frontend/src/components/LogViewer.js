import React, { useEffect, useRef, useState, useCallback } from 'react';
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

function LogViewer({ logs, searchTerm, isStreaming, isLoading, onLoadMore, hasMore, pagination }) {
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastLogCount = useRef(0);

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

          {/* Scrollable log list */}
          <div
            ref={containerRef}
            className="log-scroll-container"
            onScroll={handleScroll}
          >
            {logs.map((log, index) => (
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
