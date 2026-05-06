import { useEffect, useState } from 'react';
import { readSelectedGenres } from '../utils/genrePreferences';

export default function useSelectedGenres() {
  const [selectedGenres, setSelectedGenres] = useState(() => readSelectedGenres());

  useEffect(() => {
    const sync = () => setSelectedGenres(readSelectedGenres());

    const handleCustom = () => sync();
    const handleStorage = (event) => {
      if (!event) return;
      if (event.key === 'selectedGenres') sync();
    };

    window.addEventListener('genres:change', handleCustom);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('genres:change', handleCustom);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  return selectedGenres;
}

