import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Search } from 'lucide-react';
import useGlobalSearch from '../hooks/useGlobalSearch';
import normalizeSearchResults from '../utils/normalizeSearchResults';
import BookCoverArt from '../components/books/BookCoverArt';
import api from '../utils/api';
import './ThreadAccessHub.css';

const getArchiveBadge = (book) => {
  const source = String(book?.source || '').trim().toLowerCase();
  const isArchive = source === 'archive' || source === 'internetarchive';
  if (!isArchive) return '';
  return book?.isPublicDomain ? 'Open Access' : 'External';
};

export default function ThreadAccessHub() {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [featuredBooks, setFeaturedBooks] = useState([]);
  const { books, loading, error, query } = useGlobalSearch(searchTerm);

  const hasQuery = Boolean(query);
  const normalizedSearchResults = useMemo(() => normalizeSearchResults(books), [books]);
  const normalizedFeatured = useMemo(() => normalizeSearchResults(featuredBooks), [featuredBooks]);
  const visible = hasQuery ? normalizedSearchResults : normalizedFeatured;
  const hasResults = visible.length > 0;

  useEffect(() => {
    let cancelled = false;
    const loadFeaturedBooks = async () => {
      try {
        const { data } = await api.get('/books');
        if (cancelled) return;
        const normalized = Array.isArray(data) ? data : [];
        setFeaturedBooks(normalized.slice(0, 36).map((book) => ({
          ...book,
          source: String(book?.source || (book?.gutenbergId ? 'gutenberg' : 'local')),
          sourceId: String(book?.sourceId || book?.gutenbergId || book?._id || ''),
          coverImage: String(book?.coverImage || book?.cover || ''),
        })).filter((book) => book.sourceId));
      } catch {
        if (!cancelled) setFeaturedBooks([]);
      }
    };

    loadFeaturedBooks();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="thread-access-page animate-fade-in">
      <section className="thread-access-hero">
        <div className="thread-access-hero-row">
          <div className="thread-access-copy">
            <h1 className="font-serif">Discuss books with other readers</h1>
            <p>Open a book to view or start conversations</p>
          </div>

          <label className="thread-access-search" htmlFor="thread-search-input">
            <Search size={16} aria-hidden="true" />
            <input
              id="thread-search-input"
              type="search"
              value={searchTerm}
              placeholder="Type a book title or author"
              onChange={(event) => setSearchTerm(event.target.value)}
              aria-label="Search thread books"
            />
          </label>
        </div>
      </section>

      <section className="thread-access-grid">
        {hasQuery && loading && (
          <>
            <div className="thread-search-status" role="status" aria-live="polite">
              <span className="thread-search-spinner" aria-hidden="true" />
              <span className="thread-search-status-text">
                Searching the library
                <span className="thread-search-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
              </span>
            </div>
            {Array.from({ length: 6 }).map((_, index) => (
              <article key={`thread-skeleton-${index}`} className="thread-access-card thread-access-card--skeleton" aria-hidden="true">
                <div className="thread-access-card-body">
                  <span className="thread-skeleton-line thread-skeleton-line--title" />
                  <span className="thread-skeleton-line thread-skeleton-line--author" />
                </div>
                <div className="thread-access-actions">
                  <span className="thread-skeleton-btn" />
                </div>
              </article>
            ))}
          </>
        )}

        {hasQuery && !loading && error && (
          <div className="thread-access-loading glass-panel">
            <p>{error}</p>
          </div>
        )}

        {hasQuery && !loading && !error && !hasResults && (
          <div className="thread-access-loading glass-panel">
            <p>No matching books are available in the library yet.</p>
          </div>
        )}

        {!loading && !error && hasResults && visible.map((book) => {
          const source = String(book?.source || '').trim().toLowerCase();
          const sourceId = String(book?.source_book_id || book?.id || '').trim();
          if (!source || !sourceId) return null;
          const threadRouteId = `${source}:${sourceId}`;

          return (
            <article key={threadRouteId} className="thread-access-card glass-panel">
              <div className="thread-access-cover" style={{ '--book-accent': book.coverColor || '#6f614d' }}>
                <BookCoverArt
                  book={book}
                  imgClassName="thread-access-cover-image"
                  fallbackClassName="thread-access-cover-fallback"
                  showSpine
                  showPattern={false}
                  spineClassName="thread-access-cover-spine"
                />
              </div>
              <div className="thread-access-card-body">
                <h3 className="thread-access-title font-serif">{book.title}</h3>
                <p className="thread-access-author">{book.author}</p>
                {getArchiveBadge(book) ? <p className="thread-access-author">{getArchiveBadge(book)}</p> : null}
              </div>
              <div className="thread-access-actions">
                <button
                  className="btn-primary sm thread-access-button"
                  onClick={() => navigate(`/thread/${encodeURIComponent(threadRouteId)}`, { state: { book } })}
                >
                  Open thread <ArrowRight size={14} />
                </button>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
