import React from 'react';
import { AVAILABLE_GENRES } from '../../utils/availableGenres';
import './GenreSelector.css';

const normalizeGenre = (value) => String(value || '').trim().toLowerCase();

export default function GenreSelector({ selectedGenres = [], onChange, disabled = false }) {
  const selectedSet = new Set((Array.isArray(selectedGenres) ? selectedGenres : []).map(normalizeGenre).filter(Boolean));

  return (
    <div className="genre-selector" aria-label="Genre selection">
      {AVAILABLE_GENRES.map((genre) => {
        const normalized = normalizeGenre(genre);
        const active = selectedSet.has(normalized);
        return (
          <button
            key={genre}
            type="button"
            className={`genre-pill${active ? ' is-active' : ''}`}
            onClick={() => {
              const next = active
                ? selectedGenres.filter((g) => normalizeGenre(g) !== normalized)
                : [...selectedGenres, normalized];
              onChange?.(next);
            }}
            aria-pressed={active}
            disabled={disabled}
          >
            {genre}
          </button>
        );
      })}
    </div>
  );
}
