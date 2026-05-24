import { useEffect, useMemo, useRef, useState } from 'react';
import useDebouncedValue from './useDebouncedValue';
import { getCachedSearch, setCachedSearch } from '../utils/searchCache';
import api from '../utils/api';

const normalizeQuery = (value) => String(value || '').trim();

export default function useGlobalSearch(query) {
  const debounced = useDebouncedValue(query, 300);
  const normalized = useMemo(() => normalizeQuery(debounced), [debounced]);
  const [state, setState] = useState({ loading: false, error: '', books: [] });
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();

    if (!normalized) {
      Promise.resolve().then(() => setState({ loading: false, error: '', books: [] }));
      return;
    }

    const cached = getCachedSearch(normalized);
    if (cached) {
      Promise.resolve().then(() => setState({ loading: false, error: '', books: cached }));
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    Promise.resolve().then(() => setState((prev) => ({ ...prev, loading: true, error: '' })));

    (async () => {
      try {
        const { data } = await api.get('/books/search', { params: { q: normalized }, signal: controller.signal });
        const books = Array.isArray(data?.books)
          ? data.books
          : (Array.isArray(data?.results) ? data.results : []);
        setCachedSearch(normalized, books);
        Promise.resolve().then(() => setState({ loading: false, error: '', books }));
      } catch (err) {
        const lowered = String(err?.message || '').toLowerCase();
        if (err?.name === 'AbortError' || err?.name === 'CanceledError' || lowered.includes('canceled') || lowered.includes('cancelled')) return;
        Promise.resolve().then(() => setState({ loading: false, error: '', books: [] }));
      }
    })();

    return () => controller.abort();
  }, [normalized]);

  return useMemo(() => ({ ...state, query: normalized }), [normalized, state]);
}
