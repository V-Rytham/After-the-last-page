import React from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';

const SearchBar = ({
  value,
  onChange,
  onSubmit,
  loading = false,
  categories = [],
  activeCategory,
  onCategoryChange,
  inputClassName = '',
  searchLabel = 'Search',
}) => {
  const handleSubmit = (event) => {
    event.preventDefault();
    onSubmit?.();
  };

  const handleStepCategory = (direction) => {
    if (!categories.length) return;
    const currentIndex = categories.findIndex((item) => item.value === activeCategory);
    const safeIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (safeIndex + direction + categories.length) % categories.length;
    onCategoryChange?.(categories[nextIndex]?.value);
  };

  return (
    <div className="search-wrapper">
      <form className="search-container" role="search" onSubmit={handleSubmit} aria-busy={loading ? 'true' : 'false'}>
        <div className="search-input-wrap">
          <Search size={15} aria-hidden="true" className="search-input-icon" />
          <span className="search-state-label" aria-live="polite">{searchLabel}</span>
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Search by title, author, genre, or Gutenberg ID"
            aria-label="Search by title, author, genre, or Gutenberg ID"
            autoComplete="off"
            data-onboarding="search-input"
            className={inputClassName}
          />
        </div>
      </form>

      {categories.length > 0 ? (
        <div className="search-categories-row">
          <button
            type="button"
            className="search-arrow-btn"
            onClick={() => handleStepCategory(-1)}
            aria-label="Previous category"
          >
            <ChevronLeft size={15} />
          </button>

          <div className="search-category-pills" role="tablist" aria-label="Book categories">
            {categories.map((category) => {
              const isActive = activeCategory === category.value;
              return (
                <button
                  key={category.value}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`search-category-pill${isActive ? ' is-active' : ''}`}
                  onClick={() => onCategoryChange?.(category.value)}
                >
                  {category.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="search-arrow-btn"
            onClick={() => handleStepCategory(1)}
            aria-label="Next category"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default SearchBar;
