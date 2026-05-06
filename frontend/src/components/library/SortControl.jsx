import React from 'react';

const SortControl = ({ sort, onSortChange }) => (
  <div className="library-sort-controls">
    <span className="library-sort-label">Sort books</span>
    <label className="library-sort-select-wrap">
      <select value={sort} onChange={(event) => onSortChange(event.target.value)} className="library-sort-select">
        <option value="popular">Popular</option>
        <option value="latest">Latest</option>
        <option value="title">Title</option>
      </select>
    </label>
  </div>
);

export default SortControl;
