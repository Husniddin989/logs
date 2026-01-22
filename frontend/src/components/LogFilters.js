import React, { useState } from 'react';
import './LogFilters.css';

function LogFilters({
  searchTerm,
  onSearchChange,
  timeRange,
  onTimeRangeChange,
  levelFilter,
  onLevelFilterChange,
  customDateRange,
  onCustomDateRangeChange,
  isStreaming,
  onToggleStream,
  onClearLogs,
  isLoading
}) {
  const [showCustomDate, setShowCustomDate] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [fromTime, setFromTime] = useState('00:00');
  const [toTime, setToTime] = useState('23:59');

  const handleTimeRangeSelect = (value) => {
    if (value === 'custom') {
      setShowCustomDate(true);
    } else {
      setShowCustomDate(false);
      onTimeRangeChange(value);
    }
  };

  const applyCustomDateRange = () => {
    if (fromDate && toDate) {
      const from = new Date(`${fromDate}T${fromTime}`);
      const to = new Date(`${toDate}T${toTime}`);
      onCustomDateRangeChange({ from, to });
      setShowCustomDate(false);
    }
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      onSearchChange(searchTerm);
    }
  };

  return (
    <div className="log-filters">
      {/* Search */}
      <div className="filter-group search-group">
        <div className="search-input-wrapper">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            className="search-input"
            placeholder="Search in logs... (Enter to search)"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value, false)}
            onKeyDown={handleSearchKeyDown}
          />
          {searchTerm && (
            <button
              className="clear-search-btn"
              onClick={() => onSearchChange('', true)}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Time Range */}
      <div className="filter-group">
        <select
          className="filter-select time-select"
          value={showCustomDate ? 'custom' : timeRange}
          onChange={(e) => handleTimeRangeSelect(e.target.value)}
        >
          <option value="live">🔴 Live</option>
          <option value="5m">Last 5 min</option>
          <option value="15m">Last 15 min</option>
          <option value="30m">Last 30 min</option>
          <option value="1h">Last 1 hour</option>
          <option value="3h">Last 3 hours</option>
          <option value="6h">Last 6 hours</option>
          <option value="12h">Last 12 hours</option>
          <option value="24h">Last 24 hours</option>
          <option value="3d">Last 3 days</option>
          <option value="7d">Last 7 days</option>
          <option value="custom">📅 Custom range</option>
        </select>
      </div>

      {/* Custom Date Range Modal */}
      {showCustomDate && (
        <div className="custom-date-overlay">
          <div className="custom-date-modal">
            <h3>Select Date Range</h3>
            <div className="date-inputs">
              <div className="date-field">
                <label>From</label>
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
                <input
                  type="time"
                  value={fromTime}
                  onChange={(e) => setFromTime(e.target.value)}
                />
              </div>
              <div className="date-field">
                <label>To</label>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                />
                <input
                  type="time"
                  value={toTime}
                  onChange={(e) => setToTime(e.target.value)}
                />
              </div>
            </div>
            <div className="date-actions">
              <button
                className="cancel-btn"
                onClick={() => setShowCustomDate(false)}
              >
                Cancel
              </button>
              <button
                className="apply-btn"
                onClick={applyCustomDateRange}
                disabled={!fromDate || !toDate}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Level Filter */}
      <div className="filter-group">
        <select
          className="filter-select level-select"
          value={levelFilter}
          onChange={(e) => onLevelFilterChange(e.target.value)}
        >
          <option value="all">All Levels</option>
          <option value="error">🔴 Errors</option>
          <option value="warn">🟡 Warnings</option>
          <option value="info">🔵 Info</option>
          <option value="debug">⚪ Debug</option>
        </select>
      </div>

      {/* Action Buttons */}
      <div className="filter-actions">
        <button
          className={`action-btn stream-btn ${isStreaming ? 'streaming' : ''}`}
          onClick={onToggleStream}
          disabled={isLoading}
        >
          {timeRange !== 'live' ? '▶ Go Live' : (isStreaming ? '⏸ Pause' : '▶ Stream')}
        </button>

        <button
          className="action-btn clear-btn"
          onClick={onClearLogs}
        >
          🗑 Clear
        </button>
      </div>
    </div>
  );
}

export default LogFilters;
