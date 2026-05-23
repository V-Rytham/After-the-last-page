import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../utils/api';
import { getReadingSessionsForCurrentUser } from '../utils/readingSession';
import CurrentReadingCard from '../components/desk/CurrentReadingCard';
import BookCardEditorial from '../components/desk/BookCardEditorial';
import RecommendationRow from '../components/desk/RecommendationRow';
import { readSelectedGenres } from '../utils/genrePreferences';
import AuthRequired from '../components/auth/AuthRequired';
import './BooksLibrary.css';

const deskDataCache = {
  byUser: new Map(),
  inflightByUser: new Map(),
};

const DESK_CACHE_TTL_MS = 90_000;
const MAX_RECENT_ACTIVITY = 6;
const MAX_RECOMMENDATIONS_PER_TYPE = 12;
const MAX_SOCIAL_RECOMMENDATIONS = 12;
const HAS_HISTORY_MIN_PROGRESS = 1;

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const shouldRetry = (error) => {
  const status = Number(error?.statusCode || error?.response?.status || 0);
  return status === 429 || status >= 500 || !status;
};

const withRetry = async (fn, retries = 2, attempt = 0) => {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0 || !shouldRetry(error)) throw error;
    await sleep(Math.min(5000, 450 * (2 ** attempt)));
    return withRetry(fn, retries - 1, attempt + 1);
  }
};

const getBookKey = (book) => String(book?._id || book?.id || book?.gutenbergId || `${book?.title || 'book'}-${book?.author || 'unknown'}`);
const getBookObjectId = (book) => String(book?._id || book?.id || '');

const normalizeFilterValue = (value) => String(value || '').trim().toLowerCase();
const getBookSession = (sessions, book) => {
  if (!book || !sessions || typeof sessions !== 'object') return null;
  const sessionByKey = sessions[getBookKey(book)] || sessions[getBookObjectId(book)];
  if (sessionByKey) return sessionByKey;
  const gutenbergSession = sessions[String(book?.gutenbergId || '')];
  return gutenbergSession || null;
};

const getGreetingPrefix = () => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Good night';
};

const getDisplayName = (currentUser) => {
  const rawName = String(currentUser?.name || currentUser?.username || currentUser?.email || currentUser?.anonymousId || 'Reader').trim();
  if (!rawName) return 'Reader';
  if (rawName.includes('@')) return rawName.split('@')[0];
  if (rawName.startsWith('Reader #')) return 'Reader';
  return rawName.split(' ')[0];
};

const toUserCacheKey = (currentUser) => String(currentUser?._id || currentUser?.email || currentUser?.username || currentUser?.anonymousId || 'guest');

const getRecentActivity = (books, sessions) => books
  .map((book) => {
    const session = getBookSession(sessions, book);
    if (!session) return null;
    return { book, session };
  })
  .filter(Boolean)
  .sort((a, b) => new Date(b.session?.lastOpenedAt || 0).getTime() - new Date(a.session?.lastOpenedAt || 0).getTime())
  .slice(0, MAX_RECENT_ACTIVITY);

const getLastActiveBook = (books, sessions) => getRecentActivity(books, sessions)
  .find(({ session }) => Number(session?.progressPercent || 0) > 0 && Number(session?.progressPercent || 0) < 100 && !session?.isFinished)
  || null;

const hasAnyReadingHistory = (sessions) => {
  if (!sessions || typeof sessions !== 'object') return false;
  return Object.values(sessions).some((session) => Number(session?.progressPercent || 0) >= HAS_HISTORY_MIN_PROGRESS);
};

const fetchDeskData = async () => {
  const sessions = getReadingSessionsForCurrentUser();

  const { data: booksPayload } = await withRetry(() => api.get('/books'));
  const allBooks = Array.isArray(booksPayload) ? booksPayload.filter(Boolean) : [];
  const recentActivity = getRecentActivity(allBooks, sessions);
  const active = getLastActiveBook(allBooks, sessions);
  const recommendationBase = active?.book || recentActivity[0]?.book || null;
  const hasHistory = hasAnyReadingHistory(sessions) || recentActivity.length > 0;

  let recommendationError = '';
  let socialRecommendationError = '';
  let contentRecommendations = [];
  let popularRecommendations = [];
  let socialRecommendations = [];

  const selectedGenres = readSelectedGenres();
  if (selectedGenres.length > 0) {
    try {
      const recResponse = await withRetry(() => api.post('/recommendations', { genres: selectedGenres }));
      const books = Array.isArray(recResponse?.data?.books) ? recResponse.data.books : [];
      contentRecommendations = books.slice(0, MAX_RECOMMENDATIONS_PER_TYPE);
      popularRecommendations = [];
    } catch (error) {
      recommendationError = String(error?.uiMessage || error?.message || 'Recommendations are unavailable right now.');
    }
  }

  if (hasHistory) {
    try {
      const socialResponse = await withRetry(() => api.get('/recommendations/for-you'));
      const social = Array.isArray(socialResponse?.data?.recommendations) ? socialResponse.data.recommendations : [];
      socialRecommendations = social.slice(0, MAX_SOCIAL_RECOMMENDATIONS);
    } catch (error) {
      socialRecommendationError = String(error?.uiMessage || error?.message || 'Social recommendations are unavailable right now.');
    }
  }

  if (contentRecommendations.length === 0) {
    recommendationError = recommendationError || 'Pick genres in Profile to generate curated recommendations.';
  }

  return {
    books: allBooks,
    sessions,
    recommendationBase,
    contentRecommendations,
    popularRecommendations,
    recommendationError,
    socialRecommendationError,
    socialRecommendations,
    hasHistory,
    hasGenres: selectedGenres.length > 0,
    fetchedAt: Date.now(),
  };
};

const loadDeskData = async (currentUser, { force = false } = {}) => {
  const userKey = toUserCacheKey(currentUser);
  const cached = deskDataCache.byUser.get(userKey);

  if (!force && cached && Date.now() - cached.fetchedAt < DESK_CACHE_TTL_MS) {
    return cached;
  }

  const inflight = deskDataCache.inflightByUser.get(userKey);
  if (inflight) return inflight;

  const request = fetchDeskData()
    .then((payload) => {
      deskDataCache.byUser.set(userKey, payload);
      return payload;
    })
    .finally(() => {
      deskDataCache.inflightByUser.delete(userKey);
    });

  deskDataCache.inflightByUser.set(userKey, request);
  return request;
};

const BooksLibrary = ({ currentUser }) => {
  const isMember = Boolean(currentUser && !currentUser.isAnonymous);
  const [books, setBooks] = useState([]);
  const [sessions, setSessions] = useState({});
  const [contentRecommendations, setContentRecommendations] = useState([]);
  const [popularRecommendations, setPopularRecommendations] = useState([]);
  const [recommendationBase, setRecommendationBase] = useState(null);
  const [socialRecommendations, setSocialRecommendations] = useState([]);
  const [socialRecommendationError, setSocialRecommendationError] = useState('');
  const [loading, setLoading] = useState(true);
  const [recommendationLoading, setRecommendationLoading] = useState(true);
  const [error, setError] = useState('');
  const [recommendationError, setRecommendationError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [canPersonalize, setCanPersonalize] = useState(false);

  useEffect(() => {
    try {
      const prefill = String(window.sessionStorage.getItem('atlp-desk-search-prefill') || '').trim();
      if (prefill) {
        setSearchTerm(prefill);
        window.sessionStorage.removeItem('atlp-desk-search-prefill');
      }
    } catch {
      // ignore
    }
  }, []);

  const refreshDesk = useCallback(async ({ force = false } = {}) => {
    if (!isMember) {
      return;
    }

    try {
      setLoading(true);
      setRecommendationLoading(true);
      setError('');
      const payload = await loadDeskData(currentUser, { force });
      setBooks(Array.isArray(payload.books) ? payload.books : []);
      setSessions(payload.sessions && typeof payload.sessions === 'object' ? payload.sessions : {});
      setContentRecommendations(Array.isArray(payload.contentRecommendations) ? payload.contentRecommendations : []);
      setPopularRecommendations(Array.isArray(payload.popularRecommendations) ? payload.popularRecommendations : []);
      setRecommendationBase(payload.recommendationBase || null);
      setRecommendationError(payload.recommendationError || '');
      setSocialRecommendations(Array.isArray(payload.socialRecommendations) ? payload.socialRecommendations : []);
      setSocialRecommendationError(payload.socialRecommendationError || '');
      setCanPersonalize(Boolean(payload.hasHistory || payload.hasGenres));
    } catch (loadError) {
      setBooks([]);
      setContentRecommendations([]);
      setPopularRecommendations([]);
      setSocialRecommendations([]);
      setSessions(getReadingSessionsForCurrentUser());
      setError(String(loadError?.uiMessage || loadError?.message || 'Unable to load your desk right now.'));
      setCanPersonalize(false);
    } finally {
      setLoading(false);
      setRecommendationLoading(false);
    }
  }, [currentUser, isMember]);

  useEffect(() => {
    let alive = true;
    if (isMember) {
      (async () => {
        await refreshDesk({ force: true });
      })();
    }

    const refreshFromStorage = () => {
      if (!alive) return;
      setSessions(getReadingSessionsForCurrentUser());
    };

    window.addEventListener('storage', refreshFromStorage);
    window.addEventListener('focus', refreshFromStorage);

    return () => {
      alive = false;
      window.removeEventListener('storage', refreshFromStorage);
      window.removeEventListener('focus', refreshFromStorage);
    };
  }, [isMember, refreshDesk]);

  const greeting = `${getGreetingPrefix()}, ${getDisplayName(currentUser)}.`;
  const currentReading = useMemo(() => getLastActiveBook(books, sessions), [books, sessions]);
  const recentActivity = useMemo(() => getRecentActivity(books, sessions), [books, sessions]);
  const sessionForBook = useCallback((book) => getBookSession(sessions, book), [sessions]);

  const recommendationTitle = recommendationBase?.title
    ? `Because you read ${recommendationBase.title}`
    : 'Recommended for you';
  const recommendationLoadingTitle = 'Curating recommendations for you';
  const matchesSearchAndCategory = useCallback((book) => {
    if (!book) return false;

    const query = normalizeFilterValue(searchTerm);
    const title = normalizeFilterValue(book?.title);
    const author = normalizeFilterValue(book?.author);

    if (query && !title.includes(query) && !author.includes(query)) {
      return false;
    }

    return true;
  }, [searchTerm]);

  const filteredRecentActivity = useMemo(
    () => recentActivity.filter(({ book }) => matchesSearchAndCategory(book)),
    [matchesSearchAndCategory, recentActivity],
  );

  const filteredContentRecommendations = useMemo(
    () => contentRecommendations.filter(matchesSearchAndCategory),
    [contentRecommendations, matchesSearchAndCategory],
  );

  const filteredPopularRecommendations = useMemo(
    () => popularRecommendations.filter(matchesSearchAndCategory),
    [matchesSearchAndCategory, popularRecommendations],
  );

  const filteredSocialRecommendations = useMemo(
    () => socialRecommendations.filter(matchesSearchAndCategory),
    [matchesSearchAndCategory, socialRecommendations],
  );

  const hasRecommendations = filteredContentRecommendations.length > 0
    || filteredPopularRecommendations.length > 0
    || filteredSocialRecommendations.length > 0;
  const hasNoFilterResults = !loading
    && !recommendationLoading
    && Boolean(searchTerm.trim())
    && filteredRecentActivity.length === 0
    && filteredContentRecommendations.length === 0
    && filteredPopularRecommendations.length === 0
    && filteredSocialRecommendations.length === 0;

  return (
    !isMember ? <AuthRequired previewClassName="desk-page" previewLabel="" /> : (
    <div className="desk-page editorial-theme">
      <div className="desk-shell">
        <section className="desk-hero" aria-label="Current reading">
          <h2>{greeting}</h2>
          {loading
            ? <div className="desk-skeleton desk-skeleton--hero" />
            : <CurrentReadingCard book={currentReading?.book} session={currentReading?.session} />}
        </section>

        <section className="desk-section" aria-label="Recent activity">
          <div className="desk-section__heading">
            <h2>Recent activity</h2>
          </div>
          {loading ? (
            <div className="card-row card-row--recent" role="status" aria-label="Loading recent activity">
              {Array.from({ length: MAX_RECENT_ACTIVITY }).map((_, index) => <div key={`activity-skeleton-${index}`} className="desk-skeleton desk-skeleton--card" />)}
            </div>
          ) : filteredRecentActivity.length > 0 ? (
            <div className="card-row card-row--recent" role="list">
              {filteredRecentActivity.map(({ book, session }) => (
                <BookCardEditorial key={getBookKey(book)} book={book} session={session} />
              ))}
            </div>
          ) : (
            <p className="desk-empty-copy">No recent activity for this filter.</p>
          )}
        </section>

        {recommendationLoading && (
          <section className="desk-section" aria-label="Recommendations loading">
            <div className="desk-section__heading">
              <h2>{recommendationLoadingTitle}</h2>
              <p>Finding books matched to your reading history.</p>
            </div>
            <div className="card-row card-row--recommendations" role="status" aria-label="Loading recommendations">
              {Array.from({ length: 6 }).map((_, index) => <div key={`recommendation-skeleton-${index}`} className="desk-skeleton desk-skeleton--card" />)}
            </div>
          </section>
        )}

        {!recommendationLoading && hasRecommendations && (
          <>
            {filteredContentRecommendations.length > 0 && (
              <RecommendationRow
                title={recommendationTitle}
                books={filteredContentRecommendations}
                getSessionForBook={sessionForBook}
              />
            )}

            {filteredPopularRecommendations.length > 0 && (
              <RecommendationRow
                title="Trending now"
                books={filteredPopularRecommendations}
                getSessionForBook={sessionForBook}
              />
            )}

            {filteredSocialRecommendations.length > 0 && (
              <RecommendationRow
                title="Readers Like You Are Exploring"
                subtitle="People with similar reading behavior are diving into these right now."
                books={filteredSocialRecommendations}
                getSessionForBook={sessionForBook}
                onRecommendationClick={(book) => {
                  const trackedBookId = String(book?.bookId || book?._id || '');
                  if (!trackedBookId) return;
                  api.post('/recommendations/for-you/click', { bookId: trackedBookId }).catch(() => {});
                }}
              />
            )}
          </>
        )}

        {hasNoFilterResults && (
          <section className="desk-section" aria-label="No matching books">
            <p className="desk-empty-copy">No books match your current search.</p>
          </section>
        )}

        {!recommendationLoading && !hasRecommendations && (
          <section className="desk-section" aria-label="Recommendations unavailable">
            <div className="desk-section__heading">
              <h2>Recommendations</h2>
            </div>
            {!canPersonalize ? (
              <>
                <p className="desk-empty-copy">Start reading (or pick genres in your Profile) to unlock recommendations.</p>
                <a className="desk-btn desk-btn--secondary" href="/library">Browse books</a>
              </>
            ) : (
              <>
                <p className="desk-empty-copy">{recommendationError || socialRecommendationError || 'No recommendations available yet.'}</p>
                <button type="button" className="desk-btn desk-btn--secondary" onClick={() => refreshDesk({ force: true })}>Retry recommendations</button>
              </>
            )}
          </section>
        )}

        {!loading && error && (
          <section className="desk-section" aria-label="Desk unavailable">
            <p className="desk-empty-copy">{error}</p>
            <button type="button" className="desk-btn desk-btn--secondary" onClick={() => refreshDesk({ force: true })}>Retry loading desk</button>
          </section>
        )}
      </div>
    </div>)
  );
};

export default BooksLibrary;
