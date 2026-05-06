import React, { useEffect, useMemo, useRef, useState } from 'react';
import SearchBar from '../components/library/SearchBar';
import BookGrid from '../components/library/BookGrid';
import useSelectedGenres from '../hooks/useSelectedGenres';
import useRecommendations from '../hooks/useRecommendations';
import useDebouncedValue from '../hooks/useDebouncedValue';
import useOnboarding from '../hooks/useOnboarding';
import OnboardingTooltip from '../components/onboarding/OnboardingTooltip';
import { getCachedSearch, setCachedSearch } from '../utils/searchCache';
import AuthRequired from '../components/auth/AuthRequired';
import { getApiBaseUrl } from '../utils/serviceUrls';
import { log } from '../utils/logger';
import './Library.css';

const normalizeQuery = (value) => String(value || '').trim();
const BASE_URL = getApiBaseUrl();

export default function Library({ currentUser }) {
  const selectedGenres = useSelectedGenres();
  const { books: personalizedBooks, loading: recLoading, error: recError } = useRecommendations(selectedGenres);

  const { step: onboardingStep, completed: onboardingCompleted, highlightBookId, nextStep } = useOnboarding();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [searchState, setSearchState] = useState({ loading: false, error: '', books: [] });
  const [searchingDots, setSearchingDots] = useState('.');
  const abortRef = useRef(null);

  const normalizedSearch = useMemo(() => normalizeQuery(debouncedSearch), [debouncedSearch]);

  useEffect(() => {
    const q = normalizedSearch;

    if (abortRef.current) abortRef.current.abort();

    if (!q) {
      Promise.resolve().then(() => setSearchState({ loading: false, error: '', books: [] }));
      return;
    }

    const cached = getCachedSearch(q);
    if (cached) {
      Promise.resolve().then(() => setSearchState({ loading: false, error: '', books: cached }));
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    Promise.resolve().then(() => setSearchState((prev) => ({ ...prev, loading: true, error: '' })));

    const url = `${BASE_URL}/search?q=${encodeURIComponent(q)}`;
    log('Search Query:', q);
    log('Request URL:', url);

    fetch(url, { signal: controller.signal, credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`API failed (${res.status})`);
        }
        return res.json();
      })
      .then((data) => {
        const books = Array.isArray(data?.books) ? data.books : [];
        setCachedSearch(q, books);
        Promise.resolve().then(() => setSearchState({ loading: false, error: '', books }));

        if (!onboardingCompleted && onboardingStep === 1) {
          nextStep();
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        Promise.resolve().then(() => setSearchState({ loading: false, error: err?.message || 'Search failed.', books: [] }));
      });

    return () => controller.abort();
  }, [nextStep, normalizedSearch, onboardingCompleted, onboardingStep]);

  useEffect(() => {
    if (onboardingCompleted) return undefined;
    if (onboardingStep !== 2) return undefined;
    if (!highlightBookId) return undefined;

    const timeout = window.setTimeout(() => nextStep(), 3000);
    return () => window.clearTimeout(timeout);
  }, [highlightBookId, nextStep, onboardingCompleted, onboardingStep]);

  useEffect(() => {
    if (!normalizedSearch || !searchState.loading) return undefined;
    const dotsInterval = window.setInterval(() => {
      setSearchingDots((prev) => (prev === '.' ? '..' : prev === '..' ? '...' : '.'));
    }, 360);
    return () => window.clearInterval(dotsInterval);
  }, [normalizedSearch, searchState.loading]);


  const isMember = Boolean(currentUser && !currentUser.isAnonymous);

  if (!isMember) {
    return <AuthRequired previewClassName="library-page" previewLabel="Preview your future library after signing in." />;
  }

  const showSearchResults = Boolean(normalizedSearch);
  const curatedBooks = personalizedBooks;
  const visibleBooks = showSearchResults ? searchState.books : curatedBooks;
  const loading = showSearchResults ? searchState.loading : recLoading;
  const error = showSearchResults ? searchState.error : recError;
  const searchLabel = !showSearchResults
    ? 'Search'
    : searchState.loading
      ? `Searching${searchingDots}`
      : 'Search Results';

  return (
    <main className="library-page content-container">
      {!onboardingCompleted && onboardingStep === 1 ? (
        <OnboardingTooltip
          targetSelector='[data-onboarding="search-input"]'
          placement="bottom"
          text="Search any book (try 'Atomic Habits')"
        />
      ) : null}

      {!onboardingCompleted && onboardingStep === 2 && highlightBookId ? (
        <OnboardingTooltip
          targetSelector='[data-onboarding="added-book-card"]'
          placement="top"
          text="This is your library. Track everything here."
        />
      ) : null}

      <header className="library-page-header">
        <h1>{showSearchResults ? 'Search' : 'Curated For You'}</h1>
        <SearchBar
          value={search}
          onChange={setSearch}
          onSubmit={() => {}}
          loading={loading}
          searchLabel={searchLabel}
          categories={[]}
          activeCategory={null}
          onCategoryChange={() => {}}
          inputClassName={!onboardingCompleted && onboardingStep === 1 ? 'onboarding-target-glow' : ''}
        />
        {!showSearchResults && selectedGenres.length === 0 ? (
          <p className="library-inline-message" role="status">Pick genres in your Profile to personalize this feed.</p>
        ) : null}
      </header>

      <BookGrid
        books={visibleBooks}
        loading={loading}
        error={error}
        onboardingHighlightBookId={!onboardingCompleted && onboardingStep === 2 ? highlightBookId : ''}
      />
    </main>
  );
}
