const GUTENBERG_HOST = 'https://www.gutenberg.org';
const GUTENDEX_HOST = 'https://gutendex.com';
// Project Gutenberg blocks many datacenter/cloud IP ranges on the main host,
// which surfaces as a 403/503 and, downstream, a bare 502 in the reader. These
// mirrors sit on different infrastructure and serve the identical files, so we
// fall through to them when the main host refuses us.
const GUTENBERG_MIRRORS = ['https://gutenberg.pglaf.org', 'http://aleph.gutenberg.org'];

const DEFAULT_TIMEOUT_MS = 70_000;
// Per-request cap when racing through fetch candidates: without it, six blocked
// or hung hosts could stack up to 6 x DEFAULT_TIMEOUT_MS before we give up.
const PER_ATTEMPT_TIMEOUT_MS = 20_000;
const DEFAULT_PROCESSING_BUDGET_MS = 40_000;
const DEFAULT_INITIAL_CHAPTERS = 5;

// Progressive pagination re-invokes the reader with each new cursor, and every
// call used to re-download the entire book (~hundreds of KB) just to slice a few
// more chapters out of it. That is both slow and exactly the request pattern
// that gets an IP throttled. Cache the raw text so one successful fetch serves
// every page.
const TEXT_CACHE_TTL_MS = 60 * 60 * 1000;
const TEXT_CACHE_MAX_ENTRIES = 40;
const textCache = new Map(); // gutenbergId -> { text, expiresAt }

const readTextCache = (gutenbergId) => {
  const entry = textCache.get(gutenbergId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    textCache.delete(gutenbergId);
    return null;
  }
  // Refresh recency so the map's insertion order doubles as an LRU list.
  textCache.delete(gutenbergId);
  textCache.set(gutenbergId, entry);
  return entry.text;
};

const writeTextCache = (gutenbergId, text) => {
  if (!text) return;
  textCache.delete(gutenbergId);
  textCache.set(gutenbergId, { text, expiresAt: Date.now() + TEXT_CACHE_TTL_MS });
  while (textCache.size > TEXT_CACHE_MAX_ENTRIES) {
    const oldest = textCache.keys().next().value;
    textCache.delete(oldest);
  }
};

// Project Gutenberg's mirror layout: every digit of the id except the last is a
// directory, then a folder named for the full id. Ids under 10 live under `0/`.
const mirrorDirPath = (gutenbergId) => {
  const digits = String(gutenbergId);
  const prefix = digits.length <= 1 ? '0' : digits.slice(0, -1).split('').join('/');
  return `${prefix}/${digits}`;
};

const hostOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

// Ordered by preference: the canonical main-host cache path first (authoritative
// for existence), then each mirror's UTF-8 (`-0`) and legacy (`.txt`) variants.
const buildTextCandidates = (gutenbergId) => {
  const id = String(gutenbergId);
  const candidates = [`${GUTENBERG_HOST}/cache/epub/${id}/pg${id}.txt`];
  for (const mirror of GUTENBERG_MIRRORS) {
    const dir = `${mirror}/${mirrorDirPath(id)}`;
    candidates.push(`${dir}/${id}-0.txt`, `${dir}/${id}.txt`);
  }
  return candidates;
};

export const parseStrictGutenbergId = (value) => {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const fetchWithTimeout = async (url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Request timed out.');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

// The upstream status is the only thing that distinguishes "this book does not
// exist" from "gutendex is refusing us" from "gutendex is down". Collapsing it
// into a bare 502 leaves an operator with a failing reader and nothing to go on,
// so record it on the error and in the log before mapping it to a client status.
const upstreamFailure = async (response, host, message) => {
  const body = await response.text().then(
    (text) => text.slice(0, 200),
    () => '<unreadable>',
  );
  console.error('[gutenbergReader] upstream rejected request', {
    host,
    url: response.url,
    status: response.status,
    body,
  });

  const error = new Error(message);
  error.statusCode = response.status === 404 ? 404 : 502;
  error.upstreamStatus = response.status;
  return error;
};

// Trailing slash is load-bearing: gutendex 301s `/books/{id}` to `/books/{id}/`.
export const fetchGutenbergMetadata = async (gutenbergId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const response = await fetchWithTimeout(`${GUTENDEX_HOST}/books/${encodeURIComponent(String(gutenbergId))}/`, { timeoutMs });
  if (!response.ok) {
    throw await upstreamFailure(response, GUTENDEX_HOST, `Unable to fetch metadata for Gutenberg #${gutenbergId}.`);
  }

  const payload = await response.json();
  const title = String(payload?.title || `Project Gutenberg #${gutenbergId}`).trim();
  const author = String(payload?.authors?.[0]?.name || 'Unknown').trim() || 'Unknown';
  return { title, author, gutenbergId };
};

export const fetchGutenbergText = async (gutenbergId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const cached = readTextCache(gutenbergId);
  if (cached != null) return cached;

  const perAttemptTimeout = Math.min(timeoutMs, PER_ATTEMPT_TIMEOUT_MS);
  // The main host is authoritative for whether the book exists at all, so keep
  // its response to drive the final error: a 404 there is a genuine 404, while a
  // 403/503 (an IP block) after every mirror also failed is a real 502.
  let primaryResponse = null;
  let lastResponse = null;
  let lastError = null;

  for (const url of buildTextCandidates(gutenbergId)) {
    try {
      const response = await fetchWithTimeout(url, { timeoutMs: perAttemptTimeout });
      if (response.ok) {
        const text = await response.text();
        writeTextCache(gutenbergId, text);
        return text;
      }
      lastResponse = response;
      if (!primaryResponse && url.startsWith(GUTENBERG_HOST)) primaryResponse = response;
    } catch (error) {
      // A hung or unreachable mirror shouldn't abort the fallback chain.
      lastError = error;
    }
  }

  const authoritative = primaryResponse || lastResponse;
  if (authoritative) {
    throw await upstreamFailure(authoritative, hostOf(authoritative.url), `Unable to fetch Gutenberg text for #${gutenbergId}.`);
  }
  // Every candidate threw (timeouts / network errors) — surface that, not a 502.
  throw lastError || new Error(`Unable to fetch Gutenberg text for #${gutenbergId}.`);
};

// Fallback title/author when gutendex is unreachable: Project Gutenberg texts
// carry a "Title:"/"Author:" header block before the START marker.
const extractHeaderMetadata = (rawText, gutenbergId) => {
  const lines = String(rawText || '').replaceAll('\r\n', '\n').split('\n', 600);
  let title = '';
  let author = '';
  for (const line of lines) {
    if (startMarkerRegex.test(line.trim())) break;
    const titleMatch = /^title:\s*(.+)$/i.exec(line);
    if (titleMatch && !title) title = titleMatch[1].trim();
    const authorMatch = /^author:\s*(.+)$/i.exec(line);
    if (authorMatch && !author) author = authorMatch[1].trim();
  }
  return {
    title: title || `Project Gutenberg #${gutenbergId}`,
    author: author || 'Unknown',
    gutenbergId,
  };
};

export const stripGutenbergBoilerplate = (rawText) => {
  const lines = String(rawText || '').replaceAll('\r\n', '\n').split('\n');
  const startIndex = lines.findIndex((line) => /^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i.test(line.trim()));
  const endIndex = lines.findIndex((line) => /^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i.test(line.trim()));
  const start = startIndex >= 0 ? startIndex + 1 : 0;
  const end = endIndex > start ? endIndex : lines.length;
  return lines.slice(start, end).join('\n').trim();
};

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const toHtmlParagraphs = (text) => String(text || '')
  .split(/\n{2,}/)
  .map((block) => block.replace(/\n+/g, ' ').trim())
  .filter(Boolean)
  .map((block) => `<p>${escapeHtml(block)}</p>`)
  .join('\n');

export const convertTextToChapters = (cleanText) => {
  const lines = String(cleanText || '').split('\n');
  const headingRegex = /^chapter\s+(\d+|[ivxlcdm]+)\b(?:[\s.:\-–—]+(.*))?$/i;

  const chapters = [];
  let currentTitle = null;
  let buffer = [];
  let headingContinuationLines = 0;

  const flush = () => {
    if (!currentTitle) {
      buffer = [];
      return;
    }

    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) {
      currentTitle = null;
      return;
    }

    chapters.push({
      index: chapters.length + 1,
      title: currentTitle,
      html: toHtmlParagraphs(text),
    });
    currentTitle = null;
  };

  for (const line of lines) {
    const match = line.trim().match(headingRegex);
    if (match) {
      flush();
      const n = String(match[1] || chapters.length + 1);
      const suffix = String(match[2] || '').trim();
      currentTitle = suffix ? `Chapter ${n}: ${suffix}` : `Chapter ${n}`;
      headingContinuationLines = 0;
      continue;
    }

    const trimmed = line.trim();
    if (currentTitle && buffer.length === 0 && headingContinuationLines < 3 && shouldAppendHeadingContinuation(currentTitle, trimmed)) {
      currentTitle = `${currentTitle} ${trimmed}`.replace(/\s+/g, ' ').trim();
      headingContinuationLines += 1;
      continue;
    }

    if (currentTitle) {
      buffer.push(line);
    }
  }

  flush();

  if (!chapters.length) {
    const fallbackHtml = toHtmlParagraphs(cleanText);
    if (!fallbackHtml) return [];
    return [{ index: 1, title: 'Chapter 1', html: fallbackHtml }];
  }

  return chapters.filter((chapter) => chapter.html);
};

const normalizeCursor = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const int = Math.floor(num);
  return int > 0 ? int : 0;
};

const headingRegex = /^chapter\s+(\d+|[ivxlcdm]+)\b(?:[\s.:\-–—]+(.*))?$/i;
const startMarkerRegex = /^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i;
const endMarkerRegex = /^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i;

const buildChapterTitle = (match, fallbackIndex) => {
  const n = String(match?.[1] || fallbackIndex);
  const suffix = String(match?.[2] || '').trim();
  return suffix ? `Chapter ${n}: ${suffix}` : `Chapter ${n}`;
};

const shouldAppendHeadingContinuation = (title, candidateLine) => {
  const line = String(candidateLine || '').trim();
  if (!line || line.length > 180) return false;

  const normalizedTitle = String(title || '').trim();
  const titleEndsWithContinuationPunctuation = /[,:;\-–—]\s*$/.test(normalizedTitle);
  const startsLowercase = /^[a-z]/.test(line);
  const isAllCapsLine = line.length > 4 && line === line.toUpperCase() && /[A-Z]/.test(line);

  return titleEndsWithContinuationPunctuation || startsLowercase || isAllCapsLine;
};

export const processGutenbergTextProgressive = (
  rawText,
  {
    cursor = 0,
    maxChapters = null,
    processingBudgetMs = DEFAULT_PROCESSING_BUDGET_MS,
  } = {},
) => {
  const lines = String(rawText || '').replaceAll('\r\n', '\n').split('\n');
  const startLine = normalizeCursor(cursor);
  const startedAt = Date.now();
  const chapterLimit = Number.isFinite(Number(maxChapters)) ? Math.max(1, Math.floor(Number(maxChapters))) : null;

  let inBody = false;
  let currentTitle = null;
  let buffer = [];
  let processedChapters = 0;
  let processedLineCount = 0;
  let foundAnyChapterHeading = false;
  const chapters = [];
  let completed = true;
  let nextCursor = lines.length;
  let headingContinuationLines = 0;

  const flush = () => {
    if (!currentTitle) {
      buffer = [];
      return;
    }

    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) {
      currentTitle = null;
      return;
    }

    processedChapters += 1;
    chapters.push({
      index: processedChapters,
      title: currentTitle,
      html: toHtmlParagraphs(text),
    });
    currentTitle = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!inBody && startMarkerRegex.test(trimmed)) {
      inBody = true;
      continue;
    }
    if (endMarkerRegex.test(trimmed)) {
      completed = true;
      nextCursor = index + 1;
      break;
    }
    if (!inBody && (startLine > 0 || index > 0)) {
      // If we did not detect boilerplate markers, treat all lines as body.
      inBody = true;
    }
    if (!inBody || index < startLine) {
      continue;
    }

    const headingMatch = trimmed.match(headingRegex);
    if (headingMatch) {
      foundAnyChapterHeading = true;
      flush();
      currentTitle = buildChapterTitle(headingMatch, processedChapters + 1);
      headingContinuationLines = 0;
      continue;
    }

    if (currentTitle && buffer.length === 0 && headingContinuationLines < 3 && shouldAppendHeadingContinuation(currentTitle, trimmed)) {
      currentTitle = `${currentTitle} ${trimmed}`.replace(/\s+/g, ' ').trim();
      headingContinuationLines += 1;
      continue;
    }

    if (currentTitle) {
      buffer.push(line);
    }

    processedLineCount += 1;
    const limitReached = chapterLimit != null && chapters.length >= chapterLimit;
    const budgetReached = (Date.now() - startedAt) >= processingBudgetMs;
    if ((limitReached || budgetReached) && !currentTitle) {
      completed = false;
      nextCursor = index + 1;
      break;
    }
  }

  flush();

  if (!chapters.length && startLine === 0 && !foundAnyChapterHeading) {
    const fallbackHtml = toHtmlParagraphs(
      lines
        .slice(startLine, nextCursor >= startLine ? nextCursor : undefined)
        .join('\n')
        .trim(),
    );
    if (fallbackHtml) {
      chapters.push({ index: 1, title: 'Chapter 1', html: fallbackHtml });
      completed = true;
      nextCursor = lines.length;
    }
  }

  const averageLinesPerChapter = chapters.length > 0 ? Math.max(1, Math.round(processedLineCount / chapters.length)) : 600;
  const remainingLines = Math.max(0, lines.length - nextCursor);
  const remainingEstimate = Math.ceil(remainingLines / averageLinesPerChapter);
  const totalChaptersEstimated = chapters.length + Math.max(0, remainingEstimate);

  return {
    status: completed ? 'complete' : 'partial',
    chapters: chapters.filter((chapter) => chapter?.html),
    nextCursor: completed ? null : nextCursor,
    totalChaptersEstimated,
  };
};

export const readGutenbergBookStateless = async (gutenbergId, options = {}) => {
  const {
    cursor = 0,
    maxChapters = null,
    processingBudgetMs = DEFAULT_PROCESSING_BUDGET_MS,
    initialChapterCount = DEFAULT_INITIAL_CHAPTERS,
  } = options;
  // Text is the load-bearing fetch; if metadata (a separate host) is down, we
  // still serve the book with the title/author parsed from its own header.
  let metadata = null;
  try {
    metadata = await fetchGutenbergMetadata(gutenbergId, options);
  } catch (error) {
    console.error('[gutenbergReader] metadata fetch failed, falling back to header', {
      gutenbergId,
      status: error?.upstreamStatus || error?.statusCode,
    });
  }
  const rawText = await fetchGutenbergText(gutenbergId, options);
  if (!metadata) metadata = extractHeaderMetadata(rawText, gutenbergId);
  const parsedCursor = normalizeCursor(cursor);
  const effectiveChapterLimit = parsedCursor === 0 ? initialChapterCount : maxChapters;
  const processed = processGutenbergTextProgressive(rawText, {
    cursor: parsedCursor,
    maxChapters: effectiveChapterLimit,
    processingBudgetMs,
  });
  return { ...metadata, ...processed };
};
