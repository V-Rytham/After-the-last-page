import { aggregateSearch } from '../services/searchService.js';

export const getSearch = async (req, res) => {
  const q = String(req.query?.q || '').trim();
  if (!q) return res.json({ books: [] });
  const books = await aggregateSearch(q);
  return res.json({ books });
};

export const getBooksSearch = async (req, res) => {
  const q = String(req.query?.q || '').trim();
  if (!q) return res.json({ results: [] });
  const results = await aggregateSearch(q);
  return res.json({ results });
};
