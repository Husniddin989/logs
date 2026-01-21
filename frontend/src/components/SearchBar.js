import React, { useState, useEffect } from 'react';
import './SearchBar.css';

function SearchBar({ value, onChange, placeholder }) {
  const [inputValue, setInputValue] = useState(value);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (inputValue !== value) {
        onChange(inputValue);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [inputValue, onChange, value]);

  const handleClear = () => {
    setInputValue('');
    onChange('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      handleClear();
    }
  };

  return (
    <div className="search-bar">
      <span className="search-icon">🔍</span>
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="search-input"
      />
      {inputValue && (
        <button className="clear-search" onClick={handleClear}>
          ×
        </button>
      )}
    </div>
  );
}

export default SearchBar;
