import React from 'react';
import BookCard from './BookCard';

const BookShelf = ({ title, description, books = [], loading = false, error = '', emptyMessage = 'No books yet.' }) => {
  const showSkeleton = loading && books.length === 0;

  return (
    <section className="library-shelf" aria-label={title}>
      <header className="library-shelf-head">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {error ? <p className="library-shelf-error">{error}</p> : null}
      </header>

      <div className="library-shelf-track" role="list">
        {showSkeleton ? Array.from({ length: 5 }).map((_, index) => <BookCard key={`skeleton-${title}-${index}`} loading />) : null}
        {!showSkeleton && books.map((book) => <BookCard key={`${title}-${book.gutenbergId}`} book={book} />)}
        {!showSkeleton && books.length === 0 ? (
          <div className="library-shelf-empty" role="status">{emptyMessage}</div>
        ) : null}
      </div>
      <div className="library-shelf-rail" aria-hidden="true" />
    </section>
  );
};

export default BookShelf;
