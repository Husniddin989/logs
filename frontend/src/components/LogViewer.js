import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { FixedSizeList as List } from 'react-window';
import './LogViewer.css';

// Memoized log row component for better performance
const LogRow = React.memo(({ data, index, style }) => {
  const { logs, searchTerm, getLogLevel, formatTimestamp, highlightText } = data;
  const log = logs[index];

  if (!log) return null;

  return (
    <div style={style} className={`log-entry ${getLogLevel(log)}`}>
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
  const listRef = useRef(null);
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastLogCount = useRef(0);
  const [containerHeight, setContainerHeight] = useState(500);

  // Row height
  const ROW_HEIGHT = 36;

  // Update container height on resize
  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const height = containerRef.current.clientHeight;
        if (height > 0) {
          setContainerHeight(height);
        }
      }
    };

    updateHeight();
    window.addEventListener('resize', updateHeight);

    // Use ResizeObserver for more accurate tracking
    const resizeObserver = new ResizeObserver(updateHeight);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateHeight);
      resizeObserver.disconnect();
    };
  }, []);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (listRef.current && autoScroll && logs.length > lastLogCount.current && logs.length > 0) {
      listRef.current.scrollToItem(logs.length - 1, 'end');
    }
    lastLogCount.current = logs.length;
  }, [logs.length, autoScroll]);

  // Reset auto-scroll when logs are cleared
  useEffect(() => {
    if (logs.length === 0) {
      setAutoScroll(true);
    }
  }, [logs.length]);

  // Handle scroll events for auto-scroll detection and infinite loading
  const handleScroll = useCallback(({ scrollOffset, scrollUpdateWasRequested }) => {
    if (scrollUpdateWasRequested) return;

    const totalHeight = logs.length * ROW_HEIGHT;
    const isAtBottom = totalHeight - scrollOffset - containerHeight < 100;
    const isAtTop = scrollOffset < 100;

    setAutoScroll(isAtBottom);

    // Load more when scrolling to top (for older logs)
    if (isAtTop && hasMore && onLoadMore && !isLoading) {
      onLoadMore();
    }
  }, [logs.length, containerHeight, hasMore, onLoadMore, isLoading]);

  // Scroll to bottom manually
  const scrollToBottom = useCallback(() => {
    if (listRef.current && logs.length > 0) {
      setAutoScroll(true);
      listRef.current.scrollToItem(logs.length - 1, 'end');
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

  // Item data for the list (memoized)
  const itemData = useMemo(() => ({
    logs,
    searchTerm,
    getLogLevel,
    formatTimestamp,
    highlightText
  }), [logs, searchTerm, getLogLevel, formatTimestamp, highlightText]);

  return (
    <div ref={containerRef} className="log-viewer">
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
          {/* Loading indicator for pagination */}
          {isLoading && logs.length > 0 && (
            <div className="loading-more">
              Loading more logs...
            </div>
          )}

          {/* Pagination info */}
          {pagination && (
            <div className="pagination-info">
              Showing {logs.length} of {pagination.totalLogs} logs
              {pagination.hasMore && (
                <button className="load-more-btn" onClick={onLoadMore} disabled={isLoading}>
                  Load more
                </button>
              )}
            </div>
          )}

          {/* Virtual scrolling list */}
          <List
            ref={listRef}
            height={containerHeight - (pagination ? 40 : 0)}
            itemCount={logs.length}
            itemSize={ROW_HEIGHT}
            width="100%"
            itemData={itemData}
            onScroll={handleScroll}
            className="virtual-log-list"
          >
            {LogRow}
          </List>
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
