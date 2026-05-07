import React from 'react';
import BookCard from './BookCard';

const BookGrid = ({ books = [], loading = false, error = '', onboardingHighlightBookId = '', emptyTitle = 'Your shelf is waiting.', emptyMessage = 'Try searching by genre or author, or explore trending books.', onRetry = null }) => {
  if (loading) {
    return (
      <section className="library-grid-shell" role="status" aria-live="polite" aria-label="Finding books tailored for you">
        <div className="library-grid-loading-note glass-panel">
          <p className="library-grid-loading-eyebrow">Discover</p>
          <h2>Finding books tailored for you...</h2>
          <p>This may take a moment while we prepare recommendations you&apos;ll actually want to read.</p>
        </div>
        <div className="library-grid">
          {Array.from({ length: 8 }).map((_, index) => <BookCard key={`skeleton-${index}`} loading skeletonDelay={index * 80} />)}
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <div className="library-empty library-empty--error glass-panel" role="alert">
        <h2>We couldn&apos;t load your library right now.</h2>
        <p>{error}</p>
        {typeof onRetry === 'function' ? <button type="button" className="library-empty-cta" onClick={onRetry}>Try again</button> : null}
      </div>
    );
  }

  if (books.length === 0) {
    return <div className="library-empty" role="status">No books found</div>;
  }

  const visibleBooks = books.filter((book) => (
    Boolean(book)
    && String(book?.title || '').trim()
    && String(book?.author || '').trim()
    && Array.isArray(book?.genres)
    && book.genres.length > 0
  ));

  if (visibleBooks.length === 0) {
    return (
      <div className="library-empty glass-panel" role="status">
        <h2>{emptyTitle}</h2>
        <p>{emptyMessage}</p>
        <a className="library-empty-cta" href="/threads">Explore trending books</a>
      </div>
    );
  }

  return (
    <div className="library-grid" role="list">
      {visibleBooks.map((book) => (
        <BookCard
          key={`${book?.source || 'book'}:${book?.sourceId || book?.gutenbergId || book?.title}`}
          book={book}
          onboardingHighlight={Boolean(onboardingHighlightBookId) && String(`${book?.source || ''}:${book?.sourceId || book?.gutenbergId || ''}`) === String(onboardingHighlightBookId)}
        />
      ))}
    </div>
  );
};

export default React.memo(BookGrid);
