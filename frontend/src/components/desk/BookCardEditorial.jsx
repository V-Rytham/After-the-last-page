import React, { memo, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { getBestCoverUrl } from '../../utils/openLibraryCovers';

const clampProgress = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
};

const getReadingState = (session) => {
  const progress = clampProgress(session?.progressPercent);
  if (session?.isFinished || progress >= 100) {
    return { status: 'completed', readingProgress: 100 };
  }
  if (progress > 0) {
    return { status: 'in-progress', readingProgress: Math.round(progress) };
  }
  return { status: 'not-started', readingProgress: 0 };
};

const getReaderRoute = (book) => {
  const gutenbergId = String(book?.gutenbergId || '').trim();
  if (gutenbergId) {
    return `/read/gutenberg/${encodeURIComponent(gutenbergId)}`;
  }

  const source = String(book?.source || '').trim().toLowerCase();
  const sourceId = String(book?.sourceId || '').trim();
  if (source && sourceId) {
    return `/read/${encodeURIComponent(`${source}:${sourceId}`)}`;
  }

  const internalId = String(book?.bookId || book?._id || book?.id || '').trim();
  if (internalId) {
    return `/read/${encodeURIComponent(internalId)}`;
  }

  return '/read';
};

const BookCardEditorial = ({ book, session, recommendationReason = '', onOpen = null }) => {
  const coverUrl = getBestCoverUrl(book);
  const route = getReaderRoute(book);
  const title = String(book?.title || 'Untitled').trim() || 'Untitled';
  const author = String(book?.author || 'Unknown author').trim() || 'Unknown author';

  const mappedState = useMemo(() => {
    const { status, readingProgress } = getReadingState(session);
    return {
      title,
      author,
      coverImage: coverUrl || '',
      status,
      readingProgress,
    };
  }, [author, coverUrl, session, title]);

  return (
    <Link
      to={route}
      className="editorial-book-card"
      aria-label={`Open ${mappedState.title}`}
      onClick={() => {
        if (typeof onOpen === 'function') {
          onOpen(book);
        }
      }}
    >
      <div className="editorial-book-card__cover">
        {mappedState.coverImage ? (
          <img src={mappedState.coverImage} alt={`${mappedState.title} cover`} loading="lazy" decoding="async" />
        ) : (
          <div className="editorial-book-card__fallback" aria-hidden="true">{mappedState.title.slice(0, 1)}</div>
        )}
      </div>
      <h3 title={mappedState.title}>{mappedState.title}</h3>
      <p>{mappedState.author}</p>

      {recommendationReason ? (
        <p className="editorial-book-card__reason" title={`Why this recommendation? ${recommendationReason}`}>{recommendationReason}</p>
      ) : null}

      {mappedState.status === 'in-progress' && (
        <div className="editorial-book-card__progress-block">
          <div
            className="editorial-book-card__progress"
            role="progressbar"
            aria-valuenow={mappedState.readingProgress}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-label="Reading progress"
          >
            <div style={{ width: `${mappedState.readingProgress}%` }} />
          </div>
          <span className="editorial-book-card__status">{mappedState.readingProgress}%</span>
        </div>
      )}

      {mappedState.status === 'completed' && (
        <span className="editorial-book-card__status editorial-book-card__status--finished">
          <span aria-hidden="true" className="editorial-book-card__finished-dot" />
          Finished
        </span>
      )}

      {mappedState.status === 'not-started' && (
        <span className="editorial-book-card__status editorial-book-card__status--subtle">Not started</span>
      )}
    </Link>
  );
};

export default memo(BookCardEditorial);
