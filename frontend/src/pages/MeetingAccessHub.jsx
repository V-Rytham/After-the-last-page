import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Sparkles } from 'lucide-react';
import useGlobalSearch from '../hooks/useGlobalSearch';
import { useSocketConnection } from '../context/SocketContext';
import api from '../utils/api';
import { getOrCreateIdentity } from '../utils/identity';
import normalizeSearchResults, { toList } from '../utils/normalizeSearchResults';
import './MeetingAccessHub.css';

export default function MeetingAccessHub() {
  const navigate = useNavigate();
  const { socketConnected, socketConnecting, socketError, ensureConnected } = useSocketConnection();

  const [searchTerm, setSearchTerm] = useState('');
  const [featuredBooks, setFeaturedBooks] = useState([]);
  const [featuredLoading, setFeaturedLoading] = useState(false);
  const [joiningKey, setJoiningKey] = useState('');
  const [joinNotice, setJoinNotice] = useState('');
  const { books, loading, error, query } = useGlobalSearch(searchTerm);

  const hasQuery = Boolean(query);
  const normalizedSearchResults = useMemo(() => normalizeSearchResults(books), [books]);
  const normalizedFeatured = useMemo(() => normalizeSearchResults(featuredBooks), [featuredBooks]);
  const visibleBooks = hasQuery ? normalizedSearchResults : normalizedFeatured;
  const isLoading = Boolean(loading || (!hasQuery && featuredLoading && visibleBooks.length === 0));
  const isError = Boolean(error && hasQuery);
  const isEmpty = Boolean(!isLoading && !isError && hasQuery && visibleBooks.length === 0);

  useEffect(() => {
    let cancelled = false;

    const loadFeaturedBooks = async () => {
      setFeaturedLoading(true);
      try {
        const { data } = await api.get('/books/search', { params: { q: 'classic literature' } });
        if (cancelled) return;
        setFeaturedBooks(toList(data?.results).slice(0, 12));
      } catch {
        if (!cancelled) setFeaturedBooks([]);
      } finally {
        if (!cancelled) setFeaturedLoading(false);
      }
    };

    loadFeaturedBooks();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleJoinDiscussion = async (book) => {
    const key = `${book.source}:${book.source_book_id}`;
    if (!socketConnected) {
      setJoinNotice(socketConnecting ? 'Connecting…' : 'Connecting to chat…');
      return;
    }

    setJoiningKey(key);
    setJoinNotice('');

    const identity = getOrCreateIdentity();
    const attemptJoin = async () => api.post('/meet/join', {
      source: book.source,
      source_book_id: book.source_book_id,
      prefType: 'text',
      userId: identity?.userId,
      displayName: identity?.displayName,
    });

    try {
      const { data } = await attemptJoin();

      const roomId = String(data?.room_id || data?.canonical_book_id || '').trim();
      if (!roomId) throw new Error('Could not start chat.');

      navigate(`/meet/${encodeURIComponent(roomId)}`, {
        state: {
          meetRoom: {
            room_id: roomId,
            canonical_book_id: roomId,
            source: book.source,
            source_book_id: book.source_book_id,
            title: String(data?.book?.title || book.title || 'Untitled'),
            author: String(data?.book?.author || book.author || 'Unknown author'),
          },
        },
      });
    } catch (joinError) {
      const statusCode = Number(joinError?.response?.status || 0);
      const serverMessage = String(joinError?.response?.data?.message || joinError?.response?.data?.error || '').trim();
      const socketMismatch = statusCode === 409
        && (/no active socket connection/i.test(serverMessage) || serverMessage === 'SOCKET_NOT_CONNECTED');

      if (socketMismatch) {
        setJoinNotice('Reconnecting…');
        try {
          await ensureConnected({ forceReconnect: true });
          const { data } = await attemptJoin();
          const roomId = String(data?.room_id || data?.canonical_book_id || '').trim();
          if (roomId) {
            navigate(`/meet/${encodeURIComponent(roomId)}`, {
              state: {
                meetRoom: {
                  room_id: roomId,
                  canonical_book_id: roomId,
                  source: book.source,
                  source_book_id: book.source_book_id,
                  title: String(data?.book?.title || book.title || 'Untitled'),
                  author: String(data?.book?.author || book.author || 'Unknown author'),
                },
              },
            });
            return;
          }
        } catch {
          // fall through
        }
      }

      setJoinNotice('Could not start this chat right now. Please try again in a moment.');
    } finally {
      setJoiningKey('');
    }
  };

  return (
    <div className="meeting-access-page animate-fade-in">
      <section className="meeting-access-hero">
        <div className="meeting-access-hero-copy">
          <h1 className="font-serif">Find a book. Start a chat.</h1>
          <p>Start a private conversation with another reader.</p>
          {!socketConnected && socketError ? <p className="meeting-access-live-error">{socketError}</p> : null}
          {joinNotice ? <p className="meeting-access-live-error">{joinNotice}</p> : null}
        </div>
        <label className="meeting-access-search" htmlFor="meeting-search-input">
          <Search size={16} aria-hidden="true" />
          <input
            id="meeting-search-input"
            type="search"
            value={searchTerm}
            placeholder="Search by title or author"
            onChange={(event) => setSearchTerm(event.target.value)}
            aria-label="Search books to meet"
          />
        </label>
      </section>

      {isError ? (
        <section className="meeting-access-empty glass-panel">
          <h2 className="font-serif">Unable to load books right now.</h2>
          <p>{error}</p>
        </section>
      ) : null}

      {isLoading ? (
        <section className="meeting-access-results" aria-label="Loading books">
          {Array.from({ length: 5 }).map((_, index) => (
            <article key={`skeleton-${index}`} className="meeting-book-card meeting-book-card--skeleton glass-panel" aria-hidden="true">
              <div className="meeting-book-skeleton-cover" />
              <div className="meeting-book-skeleton-main">
                <div className="meeting-book-skeleton-line meeting-book-skeleton-line--title" />
                <div className="meeting-book-skeleton-line meeting-book-skeleton-line--subtitle" />
                <div className="meeting-book-skeleton-line meeting-book-skeleton-line--meta" />
                <div className="meeting-book-skeleton-pills">
                  <span className="meeting-book-skeleton-pill" />
                  <span className="meeting-book-skeleton-pill" />
                  <span className="meeting-book-skeleton-pill" />
                </div>
              </div>
              <div className="meeting-book-skeleton-side">
                <div className="meeting-book-skeleton-cta" />
                <div className="meeting-book-skeleton-status" />
              </div>
            </article>
          ))}
          <div className="meeting-loading-caption glass-panel">
            <Sparkles size={16} aria-hidden="true" />
            <div>
              <strong>Preparing reader profiles</strong>
              <p>Matching active readers and books for meaningful conversations.</p>
            </div>
          </div>
        </section>
      ) : null}

      {!isLoading && visibleBooks.length > 0 ? (
        <section className="meeting-access-results" aria-label="Meet books">
          {visibleBooks.map((book) => {
            const key = `${book.source}:${book.source_book_id}`;
            const isJoining = joiningKey === key;
            return (
              <article key={key} className="meeting-book-card glass-panel">
                <div className="meeting-book-main">
                  <h3 className="meeting-book-title" title={book.title}>{book.title}</h3>
                  <p className="meeting-book-author" title={book.author}>{book.author}</p>
                </div>
                <button
                  type="button"
                  className="meeting-book-cta"
                  disabled={Boolean(joiningKey) || !socketConnected}
                  onClick={() => handleJoinDiscussion(book)}
                >
                  {isJoining || !socketConnected ? <span className="meeting-cta-spinner" aria-hidden="true" /> : null}
                  {isJoining ? 'Starting…' : (socketConnected ? 'Start Chat' : 'Connecting…')}
                </button>
              </article>
            );
          })}
        </section>
      ) : null}

      {isEmpty ? (
        <section className="meeting-access-empty glass-panel">
          <h2 className="font-serif">Your next reading conversation is waiting.</h2>
          <p>Try a different title or author, or browse featured books to start chatting now.</p>
        </section>
      ) : null}
    </div>
  );
}
