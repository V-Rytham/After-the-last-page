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
import api from '../utils/api';
import './Library.css';

const normalizeQuery = (value) => String(value || '').trim();

export default function Library({ currentUser }) {
  const selectedGenres = useSelectedGenres();
  const { books: personalizedBooks, loading: recLoading, error: recError } = useRecommendations(selectedGenres);

  const { step: onboardingStep, completed: onboardingCompleted, highlightBookId, nextStep } = useOnboarding();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [searchState, setSearchState] = useState({ loading: false, error: '', books: [] });
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

    api.get('/books/search', { params: { q }, signal: controller.signal })
      .then((res) => res.data)
      .then((data) => {
        const books = Array.isArray(data?.books)
          ? data.books
          : (Array.isArray(data?.results) ? data.results : []);
        setCachedSearch(q, books);
        Promise.resolve().then(() => setSearchState({ loading: false, error: '', books }));

        if (!onboardingCompleted && onboardingStep === 1) {
          nextStep();
        }
      })
      .catch((err) => {
        const lowered = String(err?.message || '').toLowerCase();
        if (err?.name === 'AbortError' || err?.name === 'CanceledError' || lowered.includes('canceled') || lowered.includes('cancelled')) return;
        Promise.resolve().then(() => setSearchState({ loading: false, error: '', books: [] }));
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

  const isMember = Boolean(currentUser && !currentUser.isAnonymous);

  if (!isMember) {
    return <AuthRequired previewClassName="library-page" previewLabel="Preview your future library after signing in." />;
  }

  const showSearchResults = Boolean(normalizedSearch);
  const curatedBooks = personalizedBooks;
  const visibleBooks = showSearchResults ? searchState.books : curatedBooks;
  const loading = showSearchResults ? searchState.loading : recLoading;
  const error = showSearchResults ? searchState.error : recError;
  const isTypingSearch = Boolean(normalizeQuery(search)) && normalizeQuery(search) !== normalizedSearch;
  const isLoading = Boolean(loading || isTypingSearch);
  const searchHeading = !showSearchResults
    ? 'Curated for you'
    : (isLoading ? 'Searching' : 'Search Results');

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
        <h1 className="library-heading">
          {showSearchResults ? (
            <span className={`library-heading-state${isLoading ? ' is-searching' : ' is-results'}`}>
              {searchHeading}
              {isLoading ? <span className="library-search-dots" aria-hidden="true" /> : null}
            </span>
          ) : searchHeading}
        </h1>
        <SearchBar
          value={search}
          onChange={setSearch}
          onSubmit={() => {}}
          loading={isLoading}
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
        loading={isLoading}
        error={error}
        emptyTitle={showSearchResults ? 'No matches yet.' : 'Your shelf is waiting.'}
        emptyMessage={showSearchResults ? 'Try another author, title, or a broader genre keyword.' : 'Start with a title search, then save books to build your library.'}
        onboardingHighlightBookId={!onboardingCompleted && onboardingStep === 2 ? highlightBookId : ''}
      />
    </main>
  );
}
