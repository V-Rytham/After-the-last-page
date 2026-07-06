import React, { memo, useState } from 'react';
import { Link } from 'react-router-dom';

// Inline SVG data URI: renders instantly with no extra network request, unlike a
// remote placeholder (which made "No cover" appear a full round-trip too late).
const PLACEHOLDER_COVER = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='420'%20height='630'%20viewBox='0%200%20420%20630'%3E%3Crect%20width='420'%20height='630'%20fill='%231a2133'/%3E%3Ctext%20x='210'%20y='315'%20font-family='Georgia,serif'%20font-size='34'%20fill='%235b6784'%20text-anchor='middle'%20dominant-baseline='middle'%3ENo%20cover%3C/text%3E%3C/svg%3E";

// Labels that are availability/source markers, not real genres — hidden from the pills.
const NON_GENRE_LABELS = new Set(['external']);

const getGutenbergCoverUrl = (gutenbergId) => {
  const id = String(gutenbergId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  return `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`;
};

const normalizeGenre = (value) => String(value || '').trim();
// A remote placeholder cover is effectively "no cover" — treat it as missing so we
// use the instant inline placeholder instead of waiting on a remote request.
const isRemotePlaceholder = (url) => /placehold\.co/i.test(String(url || ''));

const BookCard = ({ book, loading = false, onboardingHighlight = false, skeletonDelay = 0 }) => {
  const [imageError, setImageError] = useState(false);

  if (loading) {
    return (
      <article className="library-book-card library-book-card--skeleton" style={{ '--skeleton-delay': `${skeletonDelay}ms` }} aria-hidden="true">
        <div className="library-book-cover skeleton" />
        <div className="library-book-title skeleton" />
        <div className="library-book-author skeleton" />
        <div className="library-book-tags-skeleton">
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
        <div className="library-book-cta skeleton" />
      </article>
    );
  }

  const title = String(book?.title || '').trim();
  const author = String(book?.author || '').trim();
  const genres = Array.isArray(book?.genres)
    ? book.genres.map(normalizeGenre).filter(Boolean).filter((genre) => !NON_GENRE_LABELS.has(genre.toLowerCase())).slice(0, 4)
    : [];
  if (!title || !author) {
    return null;
  }

  const gutenbergId = book?.gutenbergId != null ? Number(book.gutenbergId) : null;
  const source = String(book?.source || (Number.isFinite(gutenbergId) ? 'gutenberg' : '')).trim().toLowerCase();
  const sourceId = String(book?.sourceId || (Number.isFinite(gutenbergId) ? gutenbergId : '') || '').trim();
  const compositeId = source && sourceId ? `${source}:${sourceId}` : '';

  const rawCover = String(book?.coverImage || '').trim();
  const usableCover = rawCover && !isRemotePlaceholder(rawCover) ? rawCover : '';
  const coverSrc = imageError
    ? PLACEHOLDER_COVER
    : (usableCover || (source === 'gutenberg' ? (getGutenbergCoverUrl(sourceId) || PLACEHOLDER_COVER) : PLACEHOLDER_COVER));

  const readPath = source === 'gutenberg' && Number.isFinite(Number(sourceId))
    ? `/read/gutenberg/${encodeURIComponent(sourceId)}`
    : `/read/${encodeURIComponent(compositeId)}`;

  const resolvedShelfKey = compositeId;

  return (
    <article
      className={`library-book-card${onboardingHighlight ? ' is-onboarding-highlight onboarding-target-glow' : ''}`}
      data-onboarding={onboardingHighlight ? 'added-book-card' : undefined}
      data-onboarding-book-id={resolvedShelfKey}
    >
      <Link className="library-cover-link" to={readPath} aria-label={`Read ${title}`}>
        <div className="library-book-cover">
          <img src={coverSrc} alt={`${title} cover`} loading="lazy" decoding="async" onError={() => setImageError(true)} />
        </div>
      </Link>
      <h3 className="library-book-title" title={title}>{title}</h3>
      <p className="library-book-author">{author}</p>
      {genres.length > 0 ? (
        <div className="library-book-genres" aria-label="Book genres">
          {genres.map((genre) => <span key={`${resolvedShelfKey}-${genre}`} className="library-book-genre-pill">{genre}</span>)}
        </div>
      ) : null}

      <div className="library-book-actions">
        <Link className="library-book-cta" to={readPath}>Read</Link>
      </div>
    </article>
  );
};

export default memo(BookCard);
