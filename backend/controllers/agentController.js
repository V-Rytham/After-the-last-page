import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Book } from '../models/Book.js';
import { isProd } from '../utils/runtime.js';
import { log } from '../utils/logger.js';

const trimTrailingSlash = (value) => String(value || '').replace(/\/$/, '');

const normalizeBookFriendBaseUrl = (value) => {
  const trimmed = trimTrailingSlash(value);
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.origin;
  } catch {
    return trimmed.replace(/\/(api|agent|health)(?:\/.*)?$/i, '');
  }
};

const inferRenderBookFriendUrl = (req) => {
  if (!isProd()) {
    return null;
  }

  const hostCandidates = [
    req?.get?.('x-forwarded-host'),
    req?.get?.('host'),
    req?.headers?.host,
    process.env.RENDER_EXTERNAL_HOSTNAME,
    process.env.CLIENT_URL,
  ].filter(Boolean);

  for (const candidate of hostCandidates) {
    const normalized = String(candidate).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (normalized.endsWith('-api.onrender.com')) {
      return `https://${normalized.slice(0, -'-api.onrender.com'.length)}-bookfriend.onrender.com`;
    }
  }

  return null;
};

const getBookFriendBaseUrl = (req) => {
  const configured = normalizeBookFriendBaseUrl(process.env.BOOKFRIEND_SERVER_URL);
  if (configured) {
    return configured;
  }

  const inferredRenderUrl = inferRenderBookFriendUrl(req);
  if (inferredRenderUrl) {
    return inferredRenderUrl;
  }

  return 'http://127.0.0.1:5050';
};
const localSessionStore = new Map();

const isLocalFallbackEnabled = () => {
  const raw = String(process.env.BOOKFRIEND_ALLOW_LOCAL_FALLBACK || 'false').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
};

const shouldFallbackForBookFriendError = (error) => {
  const status = Number(error?.statusCode || 0);
  // The BookFriend service only supports gutenbergId / Mongo ObjectId lookups. For other
  // sources (OpenLibrary, Google Books, etc.) it commonly returns 404, so we fall back.
  return status === 404 || status === 422 || status === 400;
};

const parseBookId = (bookId) => {
  const raw = String(bookId || '').trim();
  const composite = raw.match(/^([a-z0-9_-]+):(.+)$/i);
  if (composite) {
    const [, sourceRaw, sourceIdRaw] = composite;
    const source = String(sourceRaw || '').trim().toLowerCase();
    const sourceId = String(sourceIdRaw || '').trim();
    if (source === 'gutenberg' && /^\d+$/.test(sourceId)) {
      return { gutenbergId: Number.parseInt(sourceId, 10) };
    }
  }

  const gutenbergMatch = raw.match(/^g?(\d+)$/i);
  if (gutenbergMatch) {
    return { gutenbergId: Number.parseInt(gutenbergMatch[1], 10) };
  }

  if (mongoose.Types.ObjectId.isValid(raw)) {
    return { _id: raw };
  }

  return null;
};

const findBookForAgent = async (bookId) => {
  const query = parseBookId(bookId);
  if (!query) {
    return null;
  }

  return Book.findOne(query)
    .select('title author synopsis tags chapters gutenbergId')
    .lean();
};

const validateStartPayload = (body) => {
  const bookId = String(body?.book_id || '').trim();
  if (!bookId) {
    const error = new Error('book_id is required.');
    error.statusCode = 400;
    throw error;
  }

  const chapterProgress = Number.parseInt(String(body?.chapter_progress ?? ''), 10);
  if (body?.chapter_progress != null && (!Number.isFinite(chapterProgress) || chapterProgress < 0 || chapterProgress > 10_000)) {
    const error = new Error('chapter_progress must be a valid non-negative integer.');
    error.statusCode = 400;
    throw error;
  }
};

const validateMessagePayload = (body) => {
  const sessionId = String(body?.session_id || '').trim();
  const message = String(body?.message || '').trim();
  if (!sessionId || !message) {
    const error = new Error('session_id and message are required.');
    error.statusCode = 400;
    throw error;
  }
  if (message.length > 2_000) {
    const error = new Error('message is too large.');
    error.statusCode = 400;
    throw error;
  }
};

const scoreChunkOverlap = (userMessage, chunkText) => {
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const msgTokens = new Set(normalize(userMessage).split(/\s+/).filter((token) => token.length > 2));
  if (!msgTokens.size) {
    return 0;
  }

  const chunkTokens = normalize(chunkText).split(/\s+/).filter((token) => token.length > 2);
  return chunkTokens.reduce((score, token) => score + (msgTokens.has(token) ? 1 : 0), 0);
};

const getRetrievedChunks = (book, userMessage, chapterProgress) => {
  const chunks = (Array.isArray(book?.chapters) ? book.chapters : [])
    .map((chapter) => ({
      chapterIndex: chapter.index || null,
      text: `${chapter?.title ? `${chapter.title}. ` : ''}${String(chapter?.html || '').replace(/<[^>]+>/g, ' ')}`.trim(),
    }))
    .filter((chunk) => chunk.text.length > 0);

  const progressNum = Number(chapterProgress);
  const progressAwareChunks = Number.isFinite(progressNum)
    ? chunks.filter((chunk) => chunk.chapterIndex == null || chunk.chapterIndex <= progressNum)
    : chunks;

  const activeChunks = progressAwareChunks.length > 0 ? progressAwareChunks : chunks;

  if (!activeChunks.length && book?.synopsis) {
    return [{ chapterIndex: null, text: String(book.synopsis) }];
  }

  return activeChunks
    .map((chunk) => ({ ...chunk, score: scoreChunkOverlap(userMessage, chunk.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ chapterIndex, text }) => ({ chapterIndex, text: text.slice(0, 1400) }));
};

const buildLocalAgentReply = ({ userMessage, bookTitle }) => {
  const trimmed = String(userMessage || '').trim();
  if (trimmed.length <= 8) {
    return `I like where you're going with that. In ${bookTitle}, what feeling does that moment leave with you right now?`;
  }

  if (trimmed.includes('?')) {
    return "Great question. A lot depends on how we read the characters' motivations in that scene. Which character choice feels most important to you there?";
  }

  return `That's an insightful take. I can see why that would stand out in ${bookTitle}. Do you think that moment changes how we should view the main character's decisions?`;
};

const isServiceUnavailableError = (error) => {
  if (!error) {
    return false;
  }

  return error.name === 'TypeError'
    || error.name === 'AbortError'
    || error.code === 'ECONNREFUSED'
    || error.code === 'ENOTFOUND'
    || error.code === 'ETIMEDOUT';
};

const forwardToBookFriend = async (req, path, payload) => {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const targetBaseUrl = getBookFriendBaseUrl(req);

  try {
    response = await fetch(`${targetBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    error.serviceUnavailable = isServiceUnavailableError(error);
    error.targetBaseUrl = targetBaseUrl;
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.message || 'BookFriend agent request failed.';
    const error = new Error(message);
    error.statusCode = response.status;
    error.serviceUnavailable = response.status >= 500;
    error.payload = data;
    error.targetBaseUrl = targetBaseUrl;
    throw error;
  }

  return data;
};

const createLocalFallbackSession = async ({ userId, bookId, bookTitle, bookAuthor }) => {
  const book = await findBookForAgent(bookId) || {
    title: String(bookTitle || 'this book').trim() || 'this book',
    author: String(bookAuthor || '').trim(),
    synopsis: '',
    chapters: [],
  };

  const sessionId = crypto.randomUUID();
  localSessionStore.set(sessionId, {
    sessionId,
    userId,
    book,
    messages: [],
  });

  return { session_id: sessionId, mode: 'local-fallback' };
};

export const startAgentSession = async (req, res) => {
  try {
    log('Bookfriend request body:', req.body);
    validateStartPayload(req.body || {});
    const { book_id: explicitBookId, chapter_progress: chapterProgress } = req.body || {};
    const userId = req.user?._id?.toString() || req.user?.anonymousId;
    const bookId = explicitBookId;

    if (!userId || !bookId) {
      return res.status(400).json({ message: 'book_id is required.' });
    }

    let data;

    try {
      data = await forwardToBookFriend(req, '/agent/start', {
        user_id: userId,
        book_id: bookId,
        chapter_progress: chapterProgress,
      });
    } catch (error) {
      const shouldFallback = Boolean(error?.serviceUnavailable) || shouldFallbackForBookFriendError(error);
      if (!shouldFallback) {
        throw error;
      }

      if (!isLocalFallbackEnabled() && Boolean(error?.serviceUnavailable)) {
        const body = { message: 'BookFriend service is unavailable.' };
        if (!isProd()) {
          body.target = error.targetBaseUrl || getBookFriendBaseUrl(req);
          body.hint = 'Start bookfriend-server and verify /health, or set BOOKFRIEND_ALLOW_LOCAL_FALLBACK=true.';
        }
        return res.status(503).json(body);
      }

      console.warn('[AGENT] Falling back to local BookFriend mode for start.', {
        upstreamStatus: error?.statusCode,
        upstreamMessage: error?.message,
      });

      data = await createLocalFallbackSession({
        userId,
        bookId,
        bookTitle: req.body?.book_title,
        bookAuthor: req.body?.book_author,
      });
    }

    res.status(201).json(data);
  } catch (error) {
    const status = error.statusCode || 502;
    res.status(status).json({ error: error.message || 'Unable to start BookFriend session.' });
  }
};

export const sendAgentMessage = async (req, res) => {
  try {
    log('Bookfriend request body:', req.body);
    validateMessagePayload(req.body || {});
    let data;

    try {
      data = await forwardToBookFriend(req, '/agent/message', req.body || {});
    } catch (error) {
      const shouldFallback = Boolean(error?.serviceUnavailable) || shouldFallbackForBookFriendError(error);
      if (!shouldFallback) {
        throw error;
      }

      if (!isLocalFallbackEnabled() && Boolean(error?.serviceUnavailable)) {
        const body = { message: 'BookFriend service is unavailable.' };
        if (!isProd()) {
          body.target = error.targetBaseUrl || getBookFriendBaseUrl(req);
          body.hint = 'Start bookfriend-server and verify /health, or set BOOKFRIEND_ALLOW_LOCAL_FALLBACK=true.';
        }
        return res.status(503).json(body);
      }

      console.warn('[AGENT] Falling back to local BookFriend mode for message.', {
        upstreamStatus: error?.statusCode,
        upstreamMessage: error?.message,
      });

      const { session_id: sessionId, message, chapter_progress: chapterProgress } = req.body || {};

      if (!sessionId || !message) {
        return res.status(400).json({ message: 'session_id and message are required.' });
      }

      const session = localSessionStore.get(sessionId);
      if (!session) {
        return res.status(404).json({ message: 'Session not found or expired.' });
      }

      session.messages.push({ role: 'user', content: String(message), timestamp: new Date().toISOString() });
      getRetrievedChunks(session.book, message, chapterProgress);
      const response = buildLocalAgentReply({ userMessage: message, bookTitle: session.book?.title || 'this book' });
      session.messages.push({ role: 'assistant', content: response, timestamp: new Date().toISOString() });

      data = { response, mode: 'local-fallback' };
    }

    res.json(data);
  } catch (error) {
    const status = error.statusCode || 502;
    res.status(status).json({ error: error.message || 'Unable to fetch BookFriend response.' });
  }
};

export const endAgentSession = async (req, res) => {
  try {
    log('Bookfriend request body:', req.body);
    let data;

    try {
      data = await forwardToBookFriend(req, '/agent/end', req.body || {});
    } catch (error) {
      if (!error.serviceUnavailable) {
        throw error;
      }

      if (!isLocalFallbackEnabled()) {
        const body = { message: 'BookFriend service is unavailable.' };
        if (!isProd()) {
          body.target = error.targetBaseUrl || getBookFriendBaseUrl(req);
          body.hint = 'Start bookfriend-server and verify /health, or set BOOKFRIEND_ALLOW_LOCAL_FALLBACK=true.';
        }
        return res.status(503).json(body);
      }

      console.warn('[AGENT] BookFriend unavailable, ending local fallback session.');
      const { session_id: sessionId } = req.body || {};
      if (sessionId) {
        localSessionStore.delete(sessionId);
      }
      data = { message: 'Session deleted.', mode: 'local-fallback' };
    }

    res.json(data);
  } catch (error) {
    const status = error.statusCode || 502;
    res.status(status).json({ error: error.message || 'Unable to end BookFriend session.' });
  }
};
