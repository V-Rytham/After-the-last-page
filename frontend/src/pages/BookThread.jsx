import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Heart,
  ScrollText,
  Search,
  Send,
  Share2,
  X,
} from 'lucide-react';
import api from '../utils/api';
import { getOrCreateIdentity } from '../utils/identity';
import BookCoverArt from '../components/books/BookCoverArt';
import './BookThread.css';

const initialThreadForm = { title: '', chapterReference: '', content: '' };
const MAX_VISUAL_REPLY_DEPTH = 3;
const BOOK_READ_TIMEOUT_MS = 120000;
const THREAD_CONTENT_MAX = 1000;
const THREAD_FETCH_MAX_ATTEMPTS = 3;
const THREAD_FETCH_RETRY_MS = 250;
const THREAD_LOAD_MAX_ATTEMPTS = 4;
const THREAD_LOAD_RETRY_MS = 220;

const canonicalizeThreadKey = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').slice(0, 120);
};

const formatCalendarDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = new Intl.DateTimeFormat('en', { month: 'short' }).format(date);
  return `${date.getDate()} ${month} ${date.getFullYear()}`;
};

const formatRelativeTime = (value) => {
  const timestamp = new Date(value).getTime();
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diff < hour) {
    return `${Math.max(1, Math.round(diff / minute))}m ago`;
  }

  if (diff < day) {
    return `${Math.round(diff / hour)}h ago`;
  }

  if (diff < week) {
    return `${Math.round(diff / day)}d ago`;
  }

  return formatCalendarDate(value);
};

const countReplies = (comments = []) => comments.reduce(
  (sum, comment) => sum + 1 + countReplies(comment.replies || []),
  0,
);

const hasHeartFromActor = (likedBy, actorId) => (
  Boolean(actorId && Array.isArray(likedBy) && likedBy.some((value) => String(value) === String(actorId)))
);

const getExcerpt = (text = '', maxLength = 260) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trim()}...`;
};

const getReplyCountLabel = (count) => (count === 1 ? '1 reply' : `${count} replies`);

const getAuthorDisplayName = (item) => {
  const username = String(item?.authorUsername || '').trim();
  if (username) return username;
  const displayName = String(item?.displayName || '').trim();
  if (displayName) return displayName;
  return 'Reader';
};

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const unwrapApiData = (response) => {
  const payload = response?.data;
  if (payload && typeof payload === 'object' && 'success' in payload) {
    return payload.data;
  }
  return payload;
};

const renderRichText = (text) => text
  .split(/\n{2,}/)
  .map((paragraph) => paragraph.trim())
  .filter(Boolean)
  .map((paragraph, index) => (
    <p key={`${paragraph.slice(0, 20)}-${index}`}>{paragraph}</p>
  ));

const ReplyTree = ({
  comments,
  depth = 0,
  threadId,
  actorId,
  replyingTo,
  replyDrafts,
  pendingReplyKey,
  onToggleReply,
  onReplyDraftChange,
  onSubmitReply,
  onLikeComment,
}) => (
  <>
    {comments.map((comment) => {
      const replyKey = `comment-${comment._id}`;
      const isReplying = replyingTo === replyKey;
      const visualDepth = Math.min(depth, MAX_VISUAL_REPLY_DEPTH);
      const hasReplies = (comment.replies || []).length > 0;
      const isHearted = hasHeartFromActor(comment.likedBy, actorId);

      return (
        <article
          key={comment._id}
          className={`reply-node ${depth > MAX_VISUAL_REPLY_DEPTH ? 'depth-capped' : ''}`}
          style={{ '--reply-depth': visualDepth }}
        >
          <div className="reply-main">
            <div className="reply-meta">
              <span className="reply-author">{getAuthorDisplayName(comment)}</span>
              <span className="reply-dot" aria-hidden="true">·</span>
              <time dateTime={comment.createdAt} className="reply-time">
                {formatRelativeTime(comment.createdAt)}
              </time>
            </div>

            <div className="reply-content">
              {renderRichText(comment.content)}
            </div>

            <div className="reply-actions">
              <button type="button" className="reply-action" onClick={() => onToggleReply(isReplying ? null : replyKey)}>
                Reply
              </button>
              <button
                type="button"
                className={`reply-action like-button ${isHearted ? 'is-liked' : ''}`}
                onClick={() => onLikeComment(threadId, comment._id)}
                aria-pressed={isHearted}
                title={isHearted ? 'Remove heart' : 'Send a heart'}
              >
                <Heart size={16} aria-hidden="true" fill={isHearted ? 'currentColor' : 'none'} />
                {comment.likes > 0 && <span className="like-count">{comment.likes}</span>}
              </button>
            </div>

            {isReplying && (
              <form
                className="inline-reply-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  onSubmitReply(threadId, comment._id);
                }}
              >
                <div className="writing-surface-copy">
                  <span className="writing-label">Response</span>
                  <p>Add your response to this thread</p>
                </div>
                <textarea
                  className="thread-textarea compact"
                  rows={4}
                  value={replyDrafts[replyKey] || ''}
                  onChange={(event) => onReplyDraftChange(replyKey, event.target.value)}
                  placeholder={`Reply to ${getAuthorDisplayName(comment)}...`}
                />
                <div className="inline-reply-actions">
                  <button type="button" className="text-button" onClick={() => onToggleReply(null)}>
                    Close
                  </button>
                  <button type="submit" className="thread-cta" disabled={pendingReplyKey === replyKey}>
                    <Send size={15} />
                    {pendingReplyKey === replyKey ? 'Placing response...' : 'Place response'}
                  </button>
                </div>
              </form>
            )}

            {hasReplies && (
              <div className="reply-children">
                <ReplyTree
                  comments={comment.replies}
                  depth={depth + 1}
                  threadId={threadId}
                  actorId={actorId}
                  replyingTo={replyingTo}
                  replyDrafts={replyDrafts}
                  pendingReplyKey={pendingReplyKey}
                  onToggleReply={onToggleReply}
                  onReplyDraftChange={onReplyDraftChange}
                  onSubmitReply={onSubmitReply}
                  onLikeComment={onLikeComment}
                />
              </div>
            )}
          </div>
        </article>
      );
    })}
  </>
);

export default function BookThread() {
  const { bookId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const parsedSourceRoute = useMemo(() => {
    if (!bookId) return null;
    const decodedId = decodeURIComponent(String(bookId));
    const [source, bookSourceId] = decodedId.split(':');
    const sourceId = String(bookSourceId || '').trim();
    if (!source || !sourceId) return null;
    return { source: source.trim().toLowerCase(), sourceId, composite: decodedId };
  }, [bookId]);
  const isCustomThread = useMemo(() => parsedSourceRoute?.source === 'custom', [parsedSourceRoute]);
  const customThreadTitle = useMemo(() => {
    const fromState = String(location?.state?.customTitle || '').trim();
    if (fromState) return fromState.slice(0, 160);
    if (isCustomThread) return String(parsedSourceRoute?.sourceId || '').trim();
    return '';
  }, [isCustomThread, location?.state?.customTitle, parsedSourceRoute?.sourceId]);
  const threadBookKey = useMemo(() => {
    if (isCustomThread) {
      const key = canonicalizeThreadKey(customThreadTitle);
      return key ? `custom:${key}` : String(bookId || '').trim();
    }
    return parsedSourceRoute ? parsedSourceRoute.composite : String(bookId || '').trim();
  }, [bookId, customThreadTitle, isCustomThread, parsedSourceRoute]);
  const actorId = useMemo(() => {
    const identity = getOrCreateIdentity();
    return identity?.userId ? String(identity.userId) : null;
  }, []);
  const [book, setBook] = useState(null);
  const [threads, setThreads] = useState([]);
  const [pageStatus, setPageStatus] = useState('loading');
  const [showComposer, setShowComposer] = useState(false);
  const [threadForm, setThreadForm] = useState(initialThreadForm);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [replyingTo, setReplyingTo] = useState(null);
  const [replyDrafts, setReplyDrafts] = useState({});
  const [submittingThread, setSubmittingThread] = useState(false);
  const [pendingReplyKey, setPendingReplyKey] = useState(null);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [threadSearchQuery, setThreadSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchedThreads, setSearchedThreads] = useState([]);
  useEffect(() => {
    if (!feedback) return undefined;
    const timeout = window.setTimeout(() => setFeedback(''), 4200);
    return () => window.clearTimeout(timeout);
  }, [feedback]);
  const trimmedThreadTitle = threadForm.title.trim();
  const trimmedThreadContent = threadForm.content.trim();
  const isComposerSubmitDisabled = submittingThread || !trimmedThreadTitle || !trimmedThreadContent;
  const normalizedThreadSearchQuery = String(threadSearchQuery || '').trim();
  const isSearchActive = Boolean(normalizedThreadSearchQuery);

  const fetchThreadsWithRetry = async (bookKey) => {
    let lastError = null;
    for (let attempt = 1; attempt <= THREAD_FETCH_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await api.get(`/books/${encodeURIComponent(bookKey)}/threads`, {
          params: { page: 1, limit: 25 },
        });
        return unwrapApiData(response);
      } catch (requestError) {
        lastError = requestError;
        if (attempt < THREAD_FETCH_MAX_ATTEMPTS) {
          await wait(THREAD_FETCH_RETRY_MS * attempt);
        }
      }
    }
    throw lastError;
  };

  useEffect(() => {
    const fetchData = async () => {
      setPageStatus('loading');
      setError('');

      const bookRequest = (() => {
        if (isCustomThread) {
          const title = customThreadTitle || 'Untitled';
          const key = canonicalizeThreadKey(title);
          setBook({
            _id: threadBookKey,
            id: threadBookKey,
            title,
            author: '',
            source: 'custom',
            sourceId: key,
            coverImage: null,
          });
          return Promise.resolve({ data: null });
        }

        const fromState = location?.state?.book;
        if (fromState && typeof fromState === 'object' && fromState.title) {
          setBook((prev) => ({ ...(prev || {}), ...fromState }));
        }

        if (parsedSourceRoute) {
          return api.get('/books/read', {
            timeout: BOOK_READ_TIMEOUT_MS,
            params: {
              source: parsedSourceRoute.source,
              id: parsedSourceRoute.sourceId,
              maxChapters: 1,
              processingBudgetMs: 7000,
            },
          });
        }

        return api.get(`/books/${encodeURIComponent(bookId)}`);
      })();

      const threadsRequest = isCustomThread
        ? Promise.resolve({ items: [] })
        : fetchThreadsWithRetry(threadBookKey);

      const [bookResult, threadsResult] = await Promise.allSettled([
        bookRequest,
        threadsRequest,
      ]);

      if (bookResult.status === 'fulfilled') {
        if (!isCustomThread) {
          const payload = bookResult.value?.data?.data || bookResult.value?.data;
          if (payload && typeof payload === 'object') {
            const prevBook = (location?.state?.book && typeof location.state.book === 'object') ? location.state.book : null;
            const sourceBook = payload?.book && typeof payload.book === 'object' ? payload.book : payload;
            const title = sourceBook?.title || payload?.title || prevBook?.title || 'Untitled';
            const author = sourceBook?.creators?.[0]?.name
              || sourceBook?.authors?.[0]?.name
              || sourceBook?.author
              || payload?.author
              || prevBook?.author
              || 'Unknown author';
            const cover = sourceBook?.formats?.['image/jpeg']
              || sourceBook?.formats?.['image/png']
              || sourceBook?.coverImage
              || payload?.coverImage
              || prevBook?.coverImage
              || null;
            const bookContentAvailable = Boolean(sourceBook?.formats?.['text/html'] || sourceBook?.formats?.['text/plain']);
            const parsedBook = {
              ...(prevBook || {}),
              ...payload,
              ...sourceBook,
              title: String(title).trim() || 'Untitled',
              author: String(author).trim() || 'Unknown author',
              coverImage: cover,
              source: payload?.source || parsedSourceRoute?.source || prevBook?.source,
              sourceId: payload?.sourceId || parsedSourceRoute?.sourceId || prevBook?.sourceId,
              bookContentAvailable,
              previewMessage: null,
            };
            setBook(parsedBook);
          }
        }
      } else {
        console.error('Failed to fetch book:', bookResult.reason);
        setBook(null);
      }

      if (threadsResult.status === 'fulfilled') {
        const payload = threadsResult.value;
        const normalized = Array.isArray(payload?.items)
          ? payload.items
          : (Array.isArray(payload) ? payload : []);
        setThreads(normalized);
        setPageStatus('ready');
      } else {
        console.error('Failed to fetch thread data:', threadsResult.reason);
        setThreads([]);
        setError('The discussion room is unavailable right now.');
        setPageStatus('ready');
      }
    };

    fetchData();
  }, [bookId, customThreadTitle, isCustomThread, location?.state?.book, parsedSourceRoute, threadBookKey]);

  useEffect(() => {
    if (!isSearchActive) {
      setSearchLoading(false);
      setSearchError('');
      setSearchedThreads([]);
      return undefined;
    }

    let cancelled = false;
    setSearchError('');
    setSearchLoading(true);

    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await api.get('/threads/search', {
          params: { q: normalizedThreadSearchQuery },
        });
        if (cancelled) return;
        const payload = unwrapApiData(response);
        const items = Array.isArray(payload?.items)
          ? payload.items
          : (Array.isArray(payload) ? payload : []);
        setSearchedThreads(items);
      } catch (requestError) {
        if (cancelled) return;
        setSearchedThreads([]);
        setSearchError(requestError?.uiMessage || requestError?.response?.data?.message || 'Unable to search threads right now.');
      } finally {
        if (!cancelled) {
          setSearchLoading(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [isSearchActive, normalizedThreadSearchQuery]);

  const buildReplyTree = (messages, rootMessageId) => {
    const nodes = new Map();
    const roots = [];

    (Array.isArray(messages) ? messages : []).forEach((message) => {
      if (!message?._id) return;
      if (rootMessageId && message._id === rootMessageId) return;
      nodes.set(message._id, { ...message, replies: Array.isArray(message.replies) ? message.replies : [] });
    });

    nodes.forEach((node) => {
      const parentId = node.parentMessageId || node.parentId || '';
      if (parentId && nodes.has(parentId)) {
        const parent = nodes.get(parentId);
        parent.replies = Array.isArray(parent.replies) ? parent.replies : [];
        parent.replies.push(node);
      } else {
        roots.push(node);
      }
    });

    return roots;
  };

  const findCommentNode = (comments, commentId) => {
    for (const comment of comments || []) {
      if (!comment) continue;
      if (comment._id === commentId) return comment;
      const nested = findCommentNode(comment.replies || [], commentId);
      if (nested) return nested;
    }
    return null;
  };

  const insertMessageIntoComments = (comments, message) => {
    const parentId = message.parentMessageId || '';
    if (!parentId) {
      return [...(comments || []), { ...message, replies: [] }];
    }

    const cloneTree = (nodes) => (nodes || []).map((node) => ({
      ...node,
      replies: cloneTree(node.replies),
    }));

    const next = cloneTree(comments || []);
    const parent = findCommentNode(next, parentId);
    if (!parent) {
      return [...next, { ...message, replies: [] }];
    }
    parent.replies = Array.isArray(parent.replies) ? parent.replies : [];
    parent.replies.push({ ...message, replies: [] });
    return next;
  };

  useEffect(() => {
    if (!selectedThreadId) return;
    const target = threads.find((thread) => thread._id === selectedThreadId);
    if (!target || Array.isArray(target.comments)) {
      return;
    }

    const loadAllMessages = async () => {
      try {
        setError('');
        setFeedback('');

        const aggregated = [];
        const pageLimit = 100;
        const maxPages = 20;

        for (let page = 1; page <= maxPages; page += 1) {
          const response = await api.get(`/threads/${encodeURIComponent(selectedThreadId)}/messages`, {
            params: { page, limit: pageLimit, order: 'asc' },
          });

          const data = unwrapApiData(response);
          const items = Array.isArray(data?.items) ? data.items : [];
          aggregated.push(...items);

          const totalPages = Number(data?.pagination?.totalPages || 1);
          if (page >= totalPages || items.length < pageLimit) {
            break;
          }
        }

        const nextComments = buildReplyTree(aggregated, target.rootMessageId);

        setThreads((prev) => prev.map((thread) => (
          thread._id === selectedThreadId ? { ...thread, comments: nextComments } : thread
        )));
      } catch (requestError) {
        setError(requestError?.uiMessage || requestError?.response?.data?.message || 'Unable to load responses right now.');
      }
    };

    loadAllMessages();
  }, [selectedThreadId, threads]);

  useEffect(() => {
    if (location.state?.notice) {
      setFeedback(location.state.notice);
    }
  }, [location.state]);

  useEffect(() => {
    let cancelled = false;

    const ensureThreadFromQuery = async () => {
      const selectedFromQuery = new URLSearchParams(location.search).get('thread');
      if (!selectedFromQuery) {
        return;
      }

      const existing = threads.find((thread) => thread._id === selectedFromQuery);
      if (existing) {
        setSelectedThreadId(selectedFromQuery);
        return;
      }

      let foundThread = null;
      let lastError = null;

      for (let attempt = 1; attempt <= THREAD_LOAD_MAX_ATTEMPTS; attempt += 1) {
        try {
          const response = await api.get(`/threads/${encodeURIComponent(selectedFromQuery)}`);
          foundThread = unwrapApiData(response);
          if (foundThread?._id) break;
        } catch (requestError) {
          lastError = requestError;
          if (requestError?.statusCode === 404 && attempt < THREAD_LOAD_MAX_ATTEMPTS) {
            await wait(THREAD_LOAD_RETRY_MS * attempt);
            continue;
          }
          break;
        }
      }

      if (cancelled) return;

      if (foundThread?._id) {
        setThreads((prev) => [foundThread, ...prev.filter((thread) => thread._id !== foundThread._id)]);
        setSelectedThreadId(foundThread._id);
        setError('');
        return;
      }

      if (lastError) {
        setError(lastError?.uiMessage || lastError?.response?.data?.error?.message || 'The discussion room is unavailable right now.');
      }
    };

    ensureThreadFromQuery();
    return () => {
      cancelled = true;
    };
  }, [location.search, threads]);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread._id === selectedThreadId) || null,
    [threads, selectedThreadId],
  );
  const visibleThreads = isSearchActive ? searchedThreads : threads;

  const selectedThreadReplyCount = selectedThread?.messageCount
    ? Math.max(0, Number(selectedThread.messageCount) - 1)
    : countReplies(selectedThread?.comments || []);
  const selectedThreadIsHearted = hasHeartFromActor(selectedThread?.likedBy, actorId);

  const updateThreadQuery = (threadId) => {
    const params = new URLSearchParams(location.search || '');
    if (threadId) {
      params.set('thread', threadId);
    } else {
      params.delete('thread');
    }

    const nextSearch = params.toString();
    navigate({
      pathname: location.pathname,
      search: nextSearch ? `?${nextSearch}` : '',
    }, { replace: true });
  };

  const handleOpenThread = (threadId, threadRecord = null) => {
    if (threadRecord?._id) {
      setThreads((prev) => [threadRecord, ...prev.filter((thread) => thread._id !== threadRecord._id)]);
    }
    setSelectedThreadId(threadId);
    setShowComposer(false);
    setReplyingTo(null);
    setFeedback('');
    setError('');
    updateThreadQuery(threadId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCloseThread = () => {
    setSelectedThreadId(null);
    setReplyingTo(null);
    setFeedback('');
    setError('');
    updateThreadQuery('');
  };

  const handleThreadFieldChange = (event) => {
    const { name, value } = event.target;
    const nextValue = name === 'content' ? value.slice(0, THREAD_CONTENT_MAX) : value;
    setThreadForm((prev) => ({ ...prev, [name]: nextValue }));
  };

  const handleReplyDraftChange = (key, value) => {
    setReplyDrafts((prev) => ({ ...prev, [key]: value }));
  };

  const handleCreateThread = async (event) => {
    event.preventDefault();
    if (submittingThread) {
      return;
    }
    setError('');
    setFeedback('');
    setSubmittingThread(true);

    try {
      const identity = getOrCreateIdentity();
      console.warn('[THREADS] frontend create request', { bookId: threadBookKey, userId: identity?.userId });
      const response = await api.post(`/books/${encodeURIComponent(threadBookKey)}/threads`, {
        title: threadForm.title,
        chapterReference: threadForm.chapterReference,
        content: threadForm.content,
        userId: identity?.userId,
        displayName: identity?.displayName,
      });
      const createdThread = unwrapApiData(response);
      const createdThreadId = String(createdThread?._id || '').trim();
      if (!createdThreadId) {
        throw new Error('Thread created without id.');
      }

      setThreads((prev) => [createdThread, ...prev.filter((thread) => thread._id !== createdThreadId)]);
      setThreadForm(initialThreadForm);
      setShowComposer(false);
      setSelectedThreadId(createdThreadId);
      setFeedback('Your discussion note has been placed into the room.');
      updateThreadQuery(createdThreadId);
      console.warn('[THREADS] frontend navigation triggered', { threadId: createdThreadId });
    } catch (requestError) {
      setError(requestError?.uiMessage || requestError?.response?.data?.message || 'Unable to publish this discussion right now.');
    } finally {
      setSubmittingThread(false);
    }
  };

  const handleSubmitReply = async (threadId, parentId = null) => {
    const replyKey = parentId ? `comment-${parentId}` : `thread-${threadId}`;
    const content = replyDrafts[replyKey]?.trim();

    if (!content) {
      return;
    }

    setError('');
    setFeedback('');
    setPendingReplyKey(replyKey);

    try {
      const identity = getOrCreateIdentity();
      const response = await api.post(`/threads/${threadId}/messages`, {
        content,
        parentMessageId: parentId,
        userId: identity?.userId,
        displayName: identity?.displayName,
      });
      const data = unwrapApiData(response);

      setThreads((prev) => prev.map((thread) => {
        if (thread._id !== threadId) return thread;
        const existing = Array.isArray(thread.comments) ? thread.comments : [];
        const nextComments = insertMessageIntoComments(existing, data);
        return {
          ...thread,
          comments: nextComments,
          messageCount: Number(thread.messageCount || 0) + 1,
        };
      }));
      setReplyDrafts((prev) => ({ ...prev, [replyKey]: '' }));
      setReplyingTo(null);
      setFeedback(parentId ? 'Your response has been added.' : 'Your note has joined the discussion.');
    } catch (requestError) {
      setError(requestError?.uiMessage || requestError?.response?.data?.message || 'Unable to post your response right now.');
    } finally {
      setPendingReplyKey(null);
    }
  };

  const handleLikeThread = async (threadId) => {
    try {
      const identity = getOrCreateIdentity();
      const response = await api.post(`/threads/${threadId}/like`, {
        userId: identity?.userId,
        displayName: identity?.displayName,
      });
      const data = unwrapApiData(response);
      setThreads((prev) => prev.map((thread) => (thread._id === threadId ? { ...thread, ...data } : thread)));
    } catch (requestError) {
      setError(requestError?.uiMessage || requestError?.response?.data?.message || 'Unable to heart this thread right now.');
    }
  };

  const handleLikeComment = async (threadId, commentId) => {
    try {
      const identity = getOrCreateIdentity();
      const response = await api.post(`/threads/${threadId}/messages/${commentId}/like`, {
        userId: identity?.userId,
        displayName: identity?.displayName,
      });
      const data = unwrapApiData(response);
      setThreads((prev) => prev.map((thread) => {
        if (thread._id !== threadId) return thread;
        const existing = Array.isArray(thread.comments) ? thread.comments : [];

        const replaceNode = (nodes) => (nodes || []).map((node) => {
          if (!node) return node;
          if (node._id === commentId) {
            return { ...node, ...data, replies: Array.isArray(node.replies) ? node.replies : [] };
          }
          return { ...node, replies: replaceNode(node.replies) };
        });

        return { ...thread, comments: replaceNode(existing) };
      }));
    } catch (requestError) {
      setError(requestError?.uiMessage || requestError?.response?.data?.message || 'Unable to heart this response right now.');
    }
  };

  const handleShareThread = async (threadId) => {
    const shareUrl = `${window.location.origin}/#/thread/${encodeURIComponent(threadBookKey)}?thread=${threadId}`;

    try {
      await navigator.clipboard.writeText(shareUrl);
      setFeedback('A direct link to this discussion has been copied.');
    } catch {
      setFeedback('Copy failed. You can copy the page URL manually.');
    }
  };

  const handleBackNavigation = () => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate('/threads', { replace: true });
  };

  if (pageStatus === 'loading') {
    return (
      <div className="thread-loader" role="status" aria-live="polite" aria-label="Opening the discussion room">
        <p>
          Opening the discussion room
          <span className="loader-dots" aria-hidden="true">
            <span>.</span><span>.</span><span>.</span>
          </span>
        </p>
      </div>
    );
  }

  if (!book) {
    return <div className="p-10 text-center mt-20">Book not found in the archives.</div>;
  }

  return (
    <div className={`thread-page animate-fade-in ${selectedThread ? 'focus-mode' : 'list-mode'}`}>
      <div className="thread-shell">
        {!selectedThread ? (
          <>
            <button type="button" className="back-link button-reset thread-page-back" onClick={handleBackNavigation}>
              <ArrowLeft size={16} /> Back
            </button>
            <header className="salon-header">
                <div className="salon-book-anchor">
                  <div className="salon-book-cover" style={{ '--book-accent': book.coverColor || '#6f614d' }}>
                  <BookCoverArt
                    book={book}
                    imgClassName="salon-book-image"
                    fallbackClassName="salon-book-fallback"
                    showSpine
                    showPattern={false}
                    spineClassName="salon-book-spine"
                  />
                  </div>

                <div className="salon-copy">
                  <div className="salon-kicker-row">
                    <span className="salon-room-label">{book.author}</span>
                    {!book?.bookContentAvailable && book?.previewMessage ? (
                      <span className="salon-room-label">{book.previewMessage}</span>
                    ) : null}
                  </div>
                  <div className="nexus-toolbar" role="toolbar" aria-label="Thread controls">
                    <h1 className="thread-title font-serif">{book.title}</h1>
                    <button
                      type="button"
                      className={showComposer ? 'btn-secondary sm' : 'thread-cta'}
                      onClick={() => setShowComposer((prev) => !prev)}
                    >
                      {showComposer ? 'Cancel' : 'Write'}
                    </button>
                  </div>
                </div>
              </div>
            </header>

            {showComposer && (
              <form className="composer-surface" onSubmit={handleCreateThread}>
                <div className="writing-field">
                  <input
                    name="title"
                    value={threadForm.title}
                    onChange={handleThreadFieldChange}
                    className="thread-input"
                    placeholder="What's your thought?"
                    maxLength={100}
                    required
                  />
                </div>

                <div className="writing-field">
                  <input
                    name="chapterReference"
                    value={threadForm.chapterReference}
                    onChange={handleThreadFieldChange}
                    className="thread-input"
                    placeholder="Reference (optional)"
                    maxLength={80}
                  />
                </div>

                <div className="writing-field">
                  <div className="textarea-wrap">
                    <textarea
                      name="content"
                      value={threadForm.content}
                      onChange={handleThreadFieldChange}
                      className="thread-textarea"
                      rows={9}
                      maxLength={THREAD_CONTENT_MAX}
                      placeholder=""
                      required
                    />
                    <span className={`composer-count inside ${threadForm.content.length >= THREAD_CONTENT_MAX * 0.8 ? 'near-limit' : ''}`}>
                      {threadForm.content.length}/{THREAD_CONTENT_MAX}
                    </span>
                  </div>
                </div>

                <div className="composer-actions">
                  <button type="submit" className="thread-cta composer-submit" disabled={isComposerSubmitDisabled}>
                    {submittingThread ? 'Publishing...' : 'Publish'}
                  </button>
                </div>
              </form>
            )}

            {(error || feedback) && (
              <div className={`thread-banner ${error ? 'error' : 'success'}`} role="status">
                <span>{error || feedback}</span>
                <button type="button" className="thread-banner-dismiss" onClick={() => { setError(''); setFeedback(''); }} aria-label="Dismiss notice">
                  <X size={14} />
                </button>
              </div>
            )}

            <section className="thread-journal-header" aria-labelledby="thread-list-heading">
              <h2 id="thread-list-heading" className="font-serif">Threads</h2>
              <label className="thread-search-input-wrap" htmlFor="thread-global-search-input">
                <Search size={15} aria-hidden="true" />
                <input
                  id="thread-global-search-input"
                  type="search"
                  value={threadSearchQuery}
                  onChange={(event) => setThreadSearchQuery(event.target.value)}
                  placeholder="Search all threads"
                  aria-label="Search all threads"
                />
              </label>
            </section>

            <section className="thread-list-surface" aria-live="polite">
              {searchLoading && (
                <div className="empty-state">
                  <h3 className="font-serif">Searching threads…</h3>
                </div>
              )}

              {!searchLoading && searchError && (
                <div className="empty-state">
                  <h3 className="font-serif">{searchError}</h3>
                </div>
              )}

              {!searchLoading && !searchError && visibleThreads.length > 0 ? visibleThreads.map((thread) => {
                const responseCount = thread?.messageCount
                  ? Math.max(0, Number(thread.messageCount) - 1)
                  : countReplies(thread.comments || []);

                return (
                  <article key={thread._id}>
                    <button type="button" className="thread-list-item thread-list-button" onClick={() => handleOpenThread(thread._id, thread)}>
                      <div className="thread-list-main">
                        <h3 className="thread-list-title font-serif">{thread.title}</h3>
                        <div className="thread-entry-context">
                          <span>{getAuthorDisplayName(thread)}</span>
                          <span className="reply-dot" aria-hidden="true">·</span>
                          <time dateTime={thread.createdAt || thread.updatedAt}>
                            {formatCalendarDate(thread.createdAt || thread.updatedAt)}
                          </time>
                          <span className="reply-dot" aria-hidden="true">·</span>
                          <span>{getReplyCountLabel(responseCount)}</span>
                        </div>
                        <p className="thread-list-preview">{getExcerpt(thread.content)}</p>
                      </div>
                    </button>
                  </article>
                );
              }) : (
                <div className="empty-state">
                  <ScrollText size={22} />
                  <h3 className="font-serif">{isSearchActive ? 'No threads found.' : 'No discussions yet.'}</h3>
                </div>
              )}
            </section>
          </>
        ) : (
          <>
            <header className="thread-focus-header">
              <button type="button" className="back-link button-reset" onClick={handleCloseThread}>
                <ArrowLeft size={16} /> Back to the room
              </button>
            </header>

            {(error || feedback) && (
              <div className={`thread-banner ${error ? 'error' : 'success'}`} role="status">
                <span>{error || feedback}</span>
                <button type="button" className="thread-banner-dismiss" onClick={() => { setError(''); setFeedback(''); }} aria-label="Dismiss notice">
                  <X size={14} />
                </button>
              </div>
            )}

            <article className="thread-focus-post" id={selectedThread._id}>
              <h1 className="thread-focus-title font-serif">{selectedThread.title}</h1>

              <div className="thread-focus-meta">
                <span className="thread-focus-author">{getAuthorDisplayName(selectedThread)}</span>
                <span className="reply-dot" aria-hidden="true">·</span>
                <time dateTime={selectedThread.createdAt}>{formatCalendarDate(selectedThread.createdAt)}</time>
                <span className="reply-dot" aria-hidden="true">·</span>
                <span>{getReplyCountLabel(selectedThreadReplyCount)}</span>
              </div>

              <div className="thread-focus-content">
                {renderRichText(selectedThread.content)}
              </div>

              <div className="thread-focus-actions">
                <button
                  type="button"
                  className={`reply-action like-button ${selectedThreadIsHearted ? 'is-liked' : ''}`}
                  onClick={() => handleLikeThread(selectedThread._id)}
                  aria-pressed={selectedThreadIsHearted}
                  title={selectedThreadIsHearted ? 'Remove heart' : 'Send a heart'}
                >
                  <Heart size={16} aria-hidden="true" fill={selectedThreadIsHearted ? 'currentColor' : 'none'} />
                  {selectedThread.likes > 0 && <span className="like-count">{selectedThread.likes}</span>}
                </button>
                <button
                  type="button"
                  className="reply-action"
                  onClick={() => setReplyingTo((current) => (
                    current === `thread-${selectedThread._id}` ? null : `thread-${selectedThread._id}`
                  ))}
                >
                  Add response
                </button>
                <button type="button" className="reply-action" onClick={() => handleShareThread(selectedThread._id)}>
                  <Share2 size={15} /> Share link
                </button>
              </div>
            </article>

            {replyingTo === `thread-${selectedThread._id}` && (
              <form
                className="inline-reply-form top-level inline-reply-form--bare"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleSubmitReply(selectedThread._id);
                }}
              >
                <textarea
                  className="thread-textarea compact"
                  rows={4}
                  value={replyDrafts[`thread-${selectedThread._id}`] || ''}
                  onChange={(event) => handleReplyDraftChange(`thread-${selectedThread._id}`, event.target.value)}
                  placeholder="Add your perspective to the discussion..."
                />
                <div className="inline-reply-actions">
                  <button type="button" className="text-button" onClick={() => setReplyingTo(null)}>
                    Close
                  </button>
                  <button
                    type="submit"
                    className="thread-cta"
                    disabled={pendingReplyKey === `thread-${selectedThread._id}`}
                  >
                    <Send size={15} />
                    {pendingReplyKey === `thread-${selectedThread._id}` ? 'Placing response...' : 'Place response'}
                  </button>
                </div>
              </form>
            )}

            <section className="thread-replies">
              {(selectedThread.comments || []).length > 0 ? (
                <ReplyTree
                  comments={selectedThread.comments}
                  threadId={selectedThread._id}
                  actorId={actorId}
                  replyingTo={replyingTo}
                  replyDrafts={replyDrafts}
                  pendingReplyKey={pendingReplyKey}
                  onToggleReply={setReplyingTo}
                  onReplyDraftChange={handleReplyDraftChange}
                  onSubmitReply={handleSubmitReply}
                  onLikeComment={handleLikeComment}
                />
              ) : (
                <div className="empty-replies">
                  <ScrollText size={22} />
                  <h3 className="font-serif">No replies yet.</h3>
                  <p>Be the first reader to answer this idea with care.</p>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
