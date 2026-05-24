import api from './api';
import { getStoredToken } from './auth';

const hasAuthSession = () => Boolean(String(getStoredToken() || '').trim());

export const saveReadingProgress = async (payload, { useBeacon = false } = {}) => {
  if (!hasAuthSession()) {
    return false;
  }

  if (useBeacon && navigator?.sendBeacon) {
    try {
      const base = api?.defaults?.baseURL || '';
      const url = `${String(base).replace(/\/$/, '')}/reading/progress`;
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      return navigator.sendBeacon(url, blob);
    } catch {
      // fallback to fetch/api
    }
  }

  await api.post('/reading/progress', payload, { timeout: 15000 });
  return true;
};

export const fetchRecentReadingActivity = async () => {
  if (!hasAuthSession()) {
    return { activities: [], sessions: [] };
  }

  const { data } = await api.get('/reading/recent', { timeout: 15000 });
  return data || { activities: [], sessions: [] };
};
