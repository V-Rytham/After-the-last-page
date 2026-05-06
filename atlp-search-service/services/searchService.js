import { searchArchiveBooks } from './archiveService.js';
import { gutenbergCatalog } from './gutenbergCatalog.js';
import { withTimeout, safeJson } from '../utils/http.js';
import { env } from '../config/env.js';

const UNKNOWN = new Set(['unknown','n/a','none','null','undefined','misc','general']);
const MAX_PER_SOURCE = 18;
const MAX_TOTAL = 45;

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const genres = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => clean(x).toLowerCase()).filter((x) => x && !UNKNOWN.has(x)))];
const key = (t,a) => `${clean(t).toLowerCase()}::${clean(a).toLowerCase()}`;

const runSafe = async (fn) => { try { return await fn(); } catch { return []; } };

const searchGutenberg = async (q) => {
  const res = await withTimeout(`https://gutendex.com/books/?search=${encodeURIComponent(q)}`, {}, env.searchTimeoutMs);
  if (!res.ok) throw new Error('Gutendex failed');
  const payload = await safeJson(res);
  const mapTags = new Map((gutenbergCatalog || []).map((b) => [Number(b?.gutenbergId), genres(b?.tags || [])]));
  return (payload?.results || []).slice(0, MAX_PER_SOURCE).map((e) => {
    const id = Number(e?.id);
    const g = genres([...(e?.subjects || []), ...(e?.bookshelves || []), ...(mapTags.get(id) || [])]);
    const title = clean(e?.title); const author = clean(e?.authors?.[0]?.name);
    if (!title || !author || !g.length) return null;
    return { title, author, gutenbergId: id, coverImage: e?.formats?.['image/jpeg'] || `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`, genres: g, source: 'gutenberg', sourceId: String(id), readable: true, isPublicDomain: true };
  }).filter(Boolean);
};

const searchOpenLibrary = async (q) => {
  const res = await withTimeout(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${MAX_PER_SOURCE}`, {}, env.searchTimeoutMs);
  if (!res.ok) throw new Error('OpenLibrary failed');
  const payload = await safeJson(res);
  return (payload?.docs || []).slice(0, MAX_PER_SOURCE).map((d) => {
    const title = clean(d?.title); const author = clean((d?.author_name || [])[0]);
    const g = genres(d?.subject || d?.subject_facet || []);
    if (!title || !author || !g.length) return null;
    const sourceId = String(d?.key || d?.edition_key?.[0] || '').replace('/works/','').trim();
    return { title, author, gutenbergId: null, coverImage: d?.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : 'https://placehold.co/420x630?text=No+Cover', genres: g, source: 'openlibrary', sourceId };
  }).filter(Boolean);
};

const searchGoogleBooks = async (q) => {
  const p = new URLSearchParams({ q, maxResults: String(MAX_PER_SOURCE), printType: 'books' });
  if (env.googleBooksApiKey) p.set('key', env.googleBooksApiKey);
  const res = await withTimeout(`https://www.googleapis.com/books/v1/volumes?${p.toString()}`, {}, env.searchTimeoutMs);
  if (!res.ok) throw new Error('Google failed');
  const payload = await safeJson(res);
  return (payload?.items || []).map((it) => {
    const v = it?.volumeInfo || {}; const title = clean(v?.title); const author = clean((v?.authors || [])[0]); const g = genres(v?.categories || []);
    if (!title || !author || !g.length) return null;
    return { title, author, gutenbergId: null, coverImage: String(v?.imageLinks?.thumbnail || '').replace('http://','https://') || 'https://placehold.co/420x630?text=No+Cover', genres: g, source: 'googlebooks', sourceId: String(it?.id || '').trim() };
  }).filter(Boolean);
};

export const aggregateSearch = async (query) => {
  const q = clean(query);
  if (!q) return [];
  const [a,b,c,d] = await Promise.all([
    runSafe(() => searchGutenberg(q)), runSafe(() => searchOpenLibrary(q)), runSafe(() => searchGoogleBooks(q)), runSafe(() => searchArchiveBooks(q)),
  ]);
  const merged = []; const seen = new Set();
  for (const item of [...a,...b,...c,...d]) {
    const k = key(item.title, item.author); if (seen.has(k)) continue; seen.add(k); merged.push(item); if (merged.length >= MAX_TOTAL) break;
  }
  return merged;
};
