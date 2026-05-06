import React from 'react';
import BookCard from './BookCard';

const BookGrid = ({ books = [], loading = false, error = '', onboardingHighlightBookId = '' }) => {
  if (loading) {
    return (
      <div className="library-grid" role="status" aria-label="Loading books">
        {Array.from({ length: 10 }).map((_, index) => <BookCard key={`skeleton-${index}`} loading />)}
      </div>
    );
  }

  if (error) {
    return <div className="library-empty" role="status">{error}</div>;
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
    return <div className="library-empty" role="status">No books found</div>;
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
