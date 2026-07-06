import { useEffect, useRef, useState } from 'react';
import api from '../utils/api';

export default function useRecommendations(selectedGenres) {
  // Start in a loading state so the grid renders skeletons on first paint
  // instead of momentarily flashing an empty / "No books found" state.
  const [state, setState] = useState({ books: [], personalized: false, loading: true, error: '' });
  const abortRef = useRef(null);
  const limit = 50;

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    Promise.resolve().then(() => setState((prev) => ({ ...prev, loading: true, error: '' })));

    // Always fetch: the backend returns personalized picks when genres are supplied
    // and a default popular catalog when the list is empty (new users).
    api.post('/recommendations', { genres: selectedGenres, limit }, { signal: controller.signal })
      .then(({ data }) => data)
      .then((data) => {
        const books = Array.isArray(data?.books) ? data.books : [];
        Promise.resolve().then(() => setState({ books, personalized: Boolean(data?.personalized), loading: false, error: '' }));
      })
      .catch((err) => {
        const lowered = String(err?.message || '').toLowerCase();
        if (err?.name === 'AbortError' || err?.name === 'CanceledError' || lowered.includes('canceled') || lowered.includes('cancelled')) {
          // A newer request superseded this one; keep loading until it resolves.
          return;
        }
        Promise.resolve().then(() => setState({ books: [], personalized: false, loading: false, error: err?.message || 'Failed to fetch recommendations.' }));
      });

    return () => controller.abort();
  }, [selectedGenres]);

  return state;
}
