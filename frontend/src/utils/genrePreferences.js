const STORAGE_KEY = 'selectedGenres';
const USER_KEY = 'currentUser';

export const normalizeGenre = (value) => String(value || '').trim().toLowerCase();

const normalizeGenreList = (genres) => Array.from(
  new Set((Array.isArray(genres) ? genres : []).map(normalizeGenre).filter(Boolean)),
);

const dispatchGenresChange = (selectedGenres) => {
  window.dispatchEvent(new CustomEvent('genres:change', { detail: { selectedGenres } }));
};

const readUserPreferredGenres = () => {
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return normalizeGenreList(parsed?.preferredGenres);
  } catch {
    return [];
  }
};

export const readSelectedGenres = () => {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return readUserPreferredGenres();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return readUserPreferredGenres();
    return normalizeGenreList(parsed);
  } catch {
    return readUserPreferredGenres();
  }
};

export const writeSelectedGenres = (genres) => {
  const normalized = normalizeGenreList(genres);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  dispatchGenresChange(normalized);
  return normalized;
};

export const syncSelectedGenresFromUser = (user) => {
  const normalized = normalizeGenreList(user?.preferredGenres);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  dispatchGenresChange(normalized);
  return normalized;
};

