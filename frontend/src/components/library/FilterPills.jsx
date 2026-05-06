import React from 'react';

const FilterPills = ({ options = [], active, onChange }) => (
  <div className="library-filter-pills" role="tablist" aria-label="Book categories">
    {options.map((option) => {
      const isActive = option.value === active;
      return (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={isActive}
          className={`library-filter-pill${isActive ? ' is-active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      );
    })}
  </div>
);

export default FilterPills;
