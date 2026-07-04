import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { getLogLevel } from '../utils/logLevel';
import './LogViewer.css';

// Memoized log row component
const LogRow = React.memo(({ log, searchTerm, formatTimestamp, highlightText }) => {
  if (!log) return null;

  return (
    <div className={`log-entry ${getLogLevel(log)}`}>
      <span className="log-timestamp" title={log.timestamp}>
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
  // Scroll position snapshot taken right before older logs are prepended
  const prependAnchor = useRef(null);

  // Keep the view pinned to the newest logs while auto-scroll is on
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

  // After older logs are prepended, restore the previous scroll position
  // so the list doesn't jump under the user's cursor
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (prependAnchor.current && el) {
      const diff = el.scrollHeight - prependAnchor.current.scrollHeight;
      if (diff > 0) {
        el.scrollTop = prependAnchor.current.scrollTop + diff;
      }
      prependAnchor.current = null;
    }
  }, [logs]);

  const requestOlderLogs = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      prependAnchor.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    }
    onLoadMore();
  }, [onLoadMore]);

  // Handle scroll events
  const handleScroll = useCallback((e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    const isAtTop = scrollTop < 100;

    setAutoScroll(isAtBottom);

    // Load older logs when scrolling to top
    if (isAtTop && hasMore && onLoadMore && !isLoading) {
      requestOlderLogs();
    }
  }, [hasMore, onLoadMore, isLoading, requestOlderLogs]);

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
                <button className="load-more-btn" onClick={requestOlderLogs} disabled={isLoading}>
                  {isLoading ? 'Loading...' : 'Load older logs'}
                </button>
              )}
            </div>
          )}

          {/* Loading indicator for pagination */}
          {isLoading && logs.length > 0 && (
            <div className="loading-more">
              Loading older logs...
            </div>
          )}

          {/* Flat chronological log list */}
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
