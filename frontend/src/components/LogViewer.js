import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import './LogViewer.css';

function LogViewer({ logs, searchTerm, isStreaming, isLoading }) {
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const isUserScrolling = useRef(false);
  const lastLogCount = useRef(0);

  // Auto-scroll to bottom when new logs arrive
  useLayoutEffect(() => {
    if (!containerRef.current) return;

    // Yangi log qo'shilganda va autoScroll yoqiq bo'lsa
    if (autoScroll && logs.length > lastLogCount.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }

    lastLogCount.current = logs.length;
  }, [logs, autoScroll]);

  // Container tanlanganda scroll reset
  useEffect(() => {
    if (containerRef.current && logs.length === 0) {
      setAutoScroll(true);
    }
  }, [logs.length]);

  // Detect manual scroll to disable auto-scroll
  const handleScroll = () => {
    if (!containerRef.current || isUserScrolling.current) return;

    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;

    // Faqat scroll holatida o'zgartirish
    if (isAtBottom !== autoScroll) {
      setAutoScroll(isAtBottom);
    }
  };

  // Mouse wheel orqali scroll qilganda
  const handleWheel = (e) => {
    if (e.deltaY < 0) {
      // Yuqoriga scroll - auto-scroll o'chirish
      setAutoScroll(false);
    }
  };

  // Scroll to bottom and enable auto-scroll
  const scrollToBottom = () => {
    if (containerRef.current) {
      setAutoScroll(true);
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  };

  // Highlight search term in log message
  const highlightText = (text, term) => {
    if (!term) return text;

    const parts = text.split(new RegExp(`(${escapeRegExp(term)})`, 'gi'));
    return parts.map((part, index) =>
      part.toLowerCase() === term.toLowerCase() ? (
        <mark key={index} className="highlight">{part}</mark>
      ) : (
        part
      )
    );
  };

  // Escape special regex characters
  const escapeRegExp = (string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  // Get log level class
  const getLogLevel = (log) => {
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
  };

  // Format timestamp
  const formatTimestamp = (timestamp) => {
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
  };

  return (
    <div
      ref={containerRef}
      className="log-viewer"
      onScroll={handleScroll}
      onWheel={handleWheel}
    >
      {isLoading ? (
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
        <div className="log-entries">
          {logs.map((log) => (
            <div
              key={log.id}
              className={`log-entry ${getLogLevel(log)}`}
            >
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
          ))}
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
