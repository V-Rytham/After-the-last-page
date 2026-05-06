import { withTimeout, safeJson } from '../utils/http.js';
import { env } from '../config/env.js';

export const searchArchiveBooks = async (q, maxResults = 18) => {
  const params = new URLSearchParams();
  params.set('q', `mediatype:texts AND (title:(${q}) OR creator:(${q}))`);
  params.set('rows', String(maxResults));
  params.set('page', '1');
  params.set('output', 'json');
  ['identifier','title','creator','licenseurl'].forEach((f) => params.append('fl[]', f));

  const response = await withTimeout(`https://archive.org/advancedsearch.php?${params.toString()}`, {}, env.archiveTimeoutMs);
  if (!response.ok) throw new Error(`Archive error ${response.status}`);
  const payload = await safeJson(response);
  return (payload?.response?.docs || []).map((doc) => ({
    title: String(doc?.title || '').trim(),
    author: String(Array.isArray(doc?.creator) ? doc.creator[0] : doc?.creator || 'Unknown author').trim(),
    source: 'archive',
    sourceId: String(doc?.identifier || '').trim(),
    coverImage: `https://archive.org/services/img/${encodeURIComponent(String(doc?.identifier || '').trim())}`,
    genres: ['external'],
    isPublicDomain: String(doc?.licenseurl || '').toLowerCase().includes('publicdomain'),
    readable: false,
  })).filter((x) => x.title && x.sourceId);
};
