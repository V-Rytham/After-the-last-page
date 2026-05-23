import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../utils/api';

export default function useRecommendations(selectedGenres) {
  const [state, setState] = useState({ books: [], personalized: false, loading: false, error: '' });
  const abortRef = useRef(null);
  const limit = 50;

  useEffect(() => {
    if (selectedGenres.length === 0) {
      return () => {};
    }


    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    Promise.resolve().then(() => setState((prev) => ({ ...prev, loading: true, error: '' })));

    api.post('/recommendations', { genres: selectedGenres, limit }, { signal: controller.signal })
      .then(({ data }) => data)
      .then((data) => {
        const books = Array.isArray(data?.books) ? data.books : [];
        Promise.resolve().then(() => setState({ books, personalized: Boolean(data?.personalized), loading: false, error: '' }));
      })
      .catch((err) => {
        const lowered = String(err?.message || '').toLowerCase();
        if (err?.name === 'AbortError' || err?.name === 'CanceledError' || lowered.includes('canceled') || lowered.includes('cancelled')) {
          Promise.resolve().then(() => setState((prev) => ({ ...prev, loading: false })));
          return;
        }
        Promise.resolve().then(() => setState({ books: [], personalized: false, loading: false, error: err?.message || 'Failed to fetch recommendations.' }));
      });

    return () => controller.abort();
  }, [selectedGenres]);

  return useMemo(() => {
    if (selectedGenres.length === 0) {
      return { books: [], personalized: false, loading: false, error: '' };
    }

    return state;
  }, [selectedGenres.length, state]);
}
