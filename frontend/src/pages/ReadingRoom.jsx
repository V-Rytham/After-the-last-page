import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle,
  ChevronLeft,
  List,
  RotateCcw,
  Settings2,
} from 'lucide-react';
import api from '../utils/api';
import { trackBookOpened, updateReadingSession } from '../utils/readingSession';
import { saveReadingProgress } from '../utils/readingActivityApi';
import { UI_THEMES } from '../utils/uiThemes';
import { PaginationEngine } from '../components/reader/PaginationEngine';
import PageRenderer from '../components/reader/PageRenderer';
import UnavailableBookState from '../components/reader/UnavailableBookState';
import './ReadingRoom.css';

const READ_REQUEST_TIMEOUT_MS = 120000;

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

const escapeHtml = (value) => (
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
);

// Gutenberg parsing is now handled server-side; keep client lean.

const ReadingRoom = ({ uiTheme, onThemeChange }) => {
  const { bookId, gutenbergId } = useParams();
  const navigate = useNavigate();

  const [book, setBook] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [contentError, setContentError] = useState(false);
  const [contentErrorMessage, setContentErrorMessage] = useState('Book content not available.');
  const [isPartialContent, setIsPartialContent] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [estimatedChapters, setEstimatedChapters] = useState(null);
  const [loadingMoreChapters, setLoadingMoreChapters] = useState(false);
  const [availability, setAvailability] = useState('unknown');
  const [availabilityNote, setAvailabilityNote] = useState('');

  const [fontSize, setFontSize] = useState(1.1875);
  const [fontFamily, setFontFamily] = useState('serif');
  const [lineHeight, setLineHeight] = useState(1.72);
  const [marginScale, setMarginScale] = useState(1);
  const [activeControlPanel, setActiveControlPanel] = useState(null);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [currentChapter, setCurrentChapter] = useState(1);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [currentPageHtml, setCurrentPageHtml] = useState('');
  const [totalPages, setTotalPages] = useState(null);
  const [paginationDone, setPaginationDone] = useState(false);
  const [pageTurnDirection, setPageTurnDirection] = useState(null);
  const [goToDraft, setGoToDraft] = useState('1');
  const [goToPageDraft, setGoToPageDraft] = useState('1');
  const [restoreSnapshot, setRestoreSnapshot] = useState(null);

  const chromeTimeoutRef = useRef(null);
  const pointerDownRef = useRef(null);
  const goToInputRef = useRef(null);
  const goToPageInputRef = useRef(null);
  const pageViewportRef = useRef(null);
  const paginationEngineRef = useRef(null);

  const isGutenbergRoute = Boolean(gutenbergId);
  const parsedSourceRoute = useMemo(() => {
    if (!bookId) return null;
    const decoded = decodeURIComponent(String(bookId));
    const separator = decoded.indexOf(':');
    if (separator <= 0) return null;
    const source = decoded.slice(0, separator).trim().toLowerCase();
    const sourceId = decoded.slice(separator + 1).trim();
    if (!source || !sourceId) return null;
    return { source, sourceId, composite: decoded };
  }, [bookId]);
  const resolvedBookId = book?._id
    || book?.id
    || (isGutenbergRoute ? String(gutenbergId || '') : (parsedSourceRoute?.composite || bookId));

  const fetchMoreChapters = useCallback(async () => {
    if (!isGutenbergRoute || nextCursor == null || loadingMoreChapters) return;
    setLoadingMoreChapters(true);
    try {
      const { data } = await api.get(`/books/gutenberg/${gutenbergId}/read`, {
        timeout: READ_REQUEST_TIMEOUT_MS,
        params: {
          cursor: nextCursor,
          maxChapters: 5,
        },
      });
      const incoming = Array.isArray(data?.chapters) ? data.chapters : [];
      if (incoming.length > 0) {
        setChapters((prev) => ([
          ...prev,
          ...incoming.map((chapter, index) => ({
            ...chapter,
            index: prev.length + index + 1,
          })),
        ]));
      }
      setIsPartialContent(data?.status === 'partial');
      setNextCursor(data?.nextCursor ?? null);
      setEstimatedChapters(Number.isFinite(Number(data?.totalChaptersEstimated)) ? Number(data.totalChaptersEstimated) : null);
    } catch (error) {
      console.error('Failed to fetch more chapters:', error);
      setContentErrorMessage(error?.uiMessage || 'Still loading, please retry.');
    } finally {
      setLoadingMoreChapters(false);
    }
  }, [gutenbergId, isGutenbergRoute, loadingMoreChapters, nextCursor]);

  useEffect(() => {
    const loadBook = async () => {
      setLoading(true);
      setContentError(false);
      setContentErrorMessage('Book content not available.');
      setBook(null);
      setChapters([]);
      setIsPartialContent(false);
      setNextCursor(null);
      setEstimatedChapters(null);
      setLoadingMoreChapters(false);
      setAvailability('unknown');
      setAvailabilityNote('');

      try {
        if (isGutenbergRoute) {
          const { data } = await api.get(`/books/gutenberg/${gutenbergId}/read`, {
            timeout: READ_REQUEST_TIMEOUT_MS,
          });
          const nextChapters = Array.isArray(data?.chapters) ? data.chapters : [];
          if (nextChapters.length === 0) {
            throw new Error('Book content response did not include chapters.');
          }

          setBook({
            _id: data?.bookId || null,
            title: data.title,
            author: data.author,
            gutenbergId: data.gutenbergId,
          });
          setChapters(nextChapters);
          setIsPartialContent(data?.status === 'partial');
          setNextCursor(data?.nextCursor ?? null);
          setEstimatedChapters(Number.isFinite(Number(data?.totalChaptersEstimated)) ? Number(data.totalChaptersEstimated) : null);
          setCurrentChapter(1);
          return;
        }

        if (parsedSourceRoute) {
          const { data: readData } = await api.get('/books/read', {
            timeout: READ_REQUEST_TIMEOUT_MS,
            params: {
              source: parsedSourceRoute.source,
              id: parsedSourceRoute.sourceId,
            },
          });
          const payload = readData?.data || readData;
          const nextChapters = Array.isArray(payload?.chapters) ? payload.chapters : [];
          if (nextChapters.length === 0) {
            throw new Error('Book content response did not include chapters.');
          }

          setBook({
            _id: parsedSourceRoute.composite,
            id: parsedSourceRoute.composite,
            title: payload?.title || 'Untitled',
            author: payload?.author || 'Unknown author',
            source: parsedSourceRoute.source,
            sourceId: parsedSourceRoute.sourceId,
            sourceUrl: readData?.sourceUrl || null,
          });
          setAvailability(payload?.availability || readData?.availability || 'unknown');
          setAvailabilityNote(payload?.availabilityNote || readData?.availabilityNote || '');
          setChapters(nextChapters);
          setCurrentChapter(1);
          return;
        }

        const { data: metadata } = await api.get(`/books/${bookId}`);
        const { data: readData } = await api.get(`/books/${bookId}/read`, {
          timeout: READ_REQUEST_TIMEOUT_MS,
        });
        const payload = readData?.data || readData;
        const nextChapters = Array.isArray(payload?.chapters) ? payload.chapters : [];
        if (nextChapters.length === 0) {
          throw new Error('Book content response did not include chapters.');
        }

        setBook(metadata);
        setChapters(nextChapters);
        setCurrentChapter(1);
      } catch (error) {
        console.error('Failed to load book:', error);
        setContentError(true);
        setContentErrorMessage(error?.uiMessage || (isGutenbergRoute ? 'Unable to fetch this book. Check the ID.' : 'Book content not available.'));
      } finally {
        setLoading(false);
      }
    };

    loadBook();
  }, [bookId, gutenbergId, isGutenbergRoute, parsedSourceRoute]);

  const totalChapters = Math.max(1, chapters.length);
  const clampedChapter = clampNumber(currentChapter, 1, totalChapters);
  const chapterIndex = clampedChapter - 1;
  const activeChapter = chapters[chapterIndex] || null;
  const isLastChapter = chapters.length > 0 && clampedChapter === totalChapters;

  const progressPercent = useMemo(
    () => Math.round((clampedChapter / totalChapters) * 100),
    [clampedChapter, totalChapters],
  );

  const resolvedTotalPages = Number.isFinite(Number(totalPages)) ? Number(totalPages) : null;
  const hasResolvedTotalPages = resolvedTotalPages != null && resolvedTotalPages > 0;
  const chapterPageProgress = hasResolvedTotalPages
    ? Math.max(0, Math.min(1, (currentPageIndex + 1) / resolvedTotalPages))
    : 0;

  const nextBookPath = book ? `/meet/${book._id || book.id}` : '/desk';

  const chapterHtmlForPagination = useMemo(() => {
    if (!activeChapter) return '';

    const kicker = escapeHtml(`Chapter ${clampedChapter} of ${totalChapters}`);
    const title = escapeHtml(activeChapter.title || `Chapter ${clampedChapter}`);
    const content = String(activeChapter.html || '');

    return [
      '<header class="chapter-heading">',
      `<span class="chapter-kicker">${kicker}</span>`,
      `<h2 class="chapter-title">${title}</h2>`,
      '</header>',
      content,
    ].join('\n');
  }, [activeChapter, clampedChapter, totalChapters]);

  const readerLayout = useMemo(() => {
    const family = fontFamily === 'sans'
      ? "'IBM Plex Sans', 'Segoe UI', sans-serif"
      : "'Literata', Georgia, serif";

    return {
      fontSizeRem: fontSize,
      lineHeight,
      fontFamily: family,
      marginScale,
    };
  }, [fontFamily, fontSize, lineHeight, marginScale]);

  
  const sessionStartedAtRef = useRef(Date.now());
  const lastPersistedSignatureRef = useRef('');

  const persistReadingProgress = useCallback(async ({ useBeacon = false } = {}) => {
    if (!book || !resolvedBookId) return;
    const totalMs = Math.max(0, Date.now() - sessionStartedAtRef.current);
    const signature = `${resolvedBookId}:${clampedChapter}:${Math.round(chapterPageProgress * 1000)}:${totalChapters}:${Math.round(totalMs / 1000)}`;
    if (signature === lastPersistedSignatureRef.current && !useBeacon) return;
    lastPersistedSignatureRef.current = signature;

    await saveReadingProgress({
      bookId: resolvedBookId,
      bookTitle: book?.title || '',
      currentPage: clampedChapter,
      totalPages: totalChapters,
      progressPercent: Math.max(0, Math.min(100, Math.round((((clampedChapter - 1) / totalChapters) + (chapterPageProgress / totalChapters)) * 100))),
      sessionDurationMs: totalMs,
    }, { useBeacon });
  }, [book, chapterPageProgress, clampedChapter, resolvedBookId, totalChapters]);

  const readerLayoutRef = useRef(readerLayout);
  useEffect(() => {
    readerLayoutRef.current = readerLayout;
  }, [readerLayout]);

  const readerLayoutSignature = useMemo(
    () => `${fontFamily}|${fontSize}|${lineHeight}|${marginScale}`,
    [fontFamily, fontSize, lineHeight, marginScale],
  );

  const readerPositionStorageKey = useMemo(() => (
    resolvedBookId ? `atlpg:reading-position:v1:${resolvedBookId}` : null
  ), [resolvedBookId]);

  const lastKnownBoundaryRef = useRef({ blockIndex: 0, textOffset: 0 });
  const lastAppliedLayoutSignatureRef = useRef(readerLayoutSignature);
  const restoredSettingsForKeyRef = useRef(null);

  useEffect(() => {
    if (!readerPositionStorageKey) {
      restoredSettingsForKeyRef.current = null;
      return;
    }

    if (restoredSettingsForKeyRef.current !== readerPositionStorageKey) {
      restoredSettingsForKeyRef.current = null;
    }
  }, [readerPositionStorageKey]);

  const clearChromeTimer = useCallback(() => {
    if (chromeTimeoutRef.current) {
      window.clearTimeout(chromeTimeoutRef.current);
      chromeTimeoutRef.current = null;
    }
  }, []);

  const scheduleChromeHide = useCallback((delay = 2200) => {
    clearChromeTimer();
    if (activeControlPanel) {
      return;
    }

    chromeTimeoutRef.current = window.setTimeout(() => {
      setChromeVisible(false);
    }, delay);
  }, [activeControlPanel, clearChromeTimer]);

  const revealChrome = (delay = 2200) => {
    setChromeVisible(true);
    scheduleChromeHide(delay);
  };

  const toggleChrome = () => {
    if (activeControlPanel) {
      setActiveControlPanel(null);
      return;
    }

    if (chromeVisible) {
      clearChromeTimer();
      setChromeVisible(false);
    } else {
      revealChrome(2200);
    }
  };

  const handleSurfacePointerDown = (event) => {
    if (event.defaultPrevented) return;
    if (event.button != null && event.button !== 0) return;

    pointerDownRef.current = {
      x: event.clientX,
      y: event.clientY,
      at: Date.now(),
    };
  };

  const handleNextPage = useCallback(() => {
    const engine = paginationEngineRef.current;
    if (!engine) return;

    const nextIndex = currentPageIndex + 1;
    const next = engine.ensurePage(nextIndex);

    if (next.html) {
      setPageTurnDirection('next');
      setCurrentPageIndex(nextIndex);
      return;
    }

    if (next.isDone && next.totalPages != null && nextIndex >= next.totalPages) {
      if (clampedChapter < totalChapters) {
        setPageTurnDirection('next');
        setCurrentChapter((chapter) => Math.min(totalChapters, chapter + 1));
        setCurrentPageIndex(0);
      }
    }
  }, [clampedChapter, currentPageIndex, totalChapters]);

  const handlePrevPage = useCallback(() => {
    if (currentPageIndex > 0) {
      setPageTurnDirection('prev');
      setCurrentPageIndex((index) => Math.max(0, index - 1));
    }
  }, [currentPageIndex]);

  const handleSurfacePointerUp = (event) => {
    if (event.defaultPrevented) return;
    if (event.button != null && event.button !== 0) return;

    const down = pointerDownRef.current;
    pointerDownRef.current = null;

    if (down) {
      const dx = event.clientX - down.x;
      const dy = event.clientY - down.y;
      const elapsed = Date.now() - down.at;
      const distance = Math.hypot(dx, dy);

      const isHorizontalSwipe = Math.abs(dx) > 46 && Math.abs(dy) < 70 && elapsed < 900;
      if (isHorizontalSwipe) {
        if (dx < 0) {
          handleNextPage();
        } else {
          handlePrevPage();
        }
        return;
      }

      if (distance > 12 || elapsed > 650) return;
    }

    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed) return;

    const path = event.composedPath?.() || [];
    const isInteractive = path.some((node) => (
      node?.tagName === 'A'
      || node?.tagName === 'BUTTON'
      || node?.tagName === 'INPUT'
      || node?.tagName === 'TEXTAREA'
      || node?.tagName === 'SELECT'
      || node?.tagName === 'LABEL'
    ));
    if (isInteractive) return;

    const viewportWidth = window.innerWidth || 1;
    const x = event.clientX / viewportWidth;

    if (x <= 0.3) {
      handlePrevPage();
      return;
    }

    if (x >= 0.7) {
      handleNextPage();
      return;
    }

    toggleChrome();
  };

  const openGoTo = () => {
    setGoToDraft(String(clampedChapter));
    setGoToPageDraft(String(currentPageIndex + 1));
    setActiveControlPanel('goto');
    window.setTimeout(() => goToInputRef.current?.focus?.(), 0);
  };

  const handleGoToSubmit = (event) => {
    event.preventDefault();
    const desired = Number.parseInt(goToDraft, 10);
    if (Number.isNaN(desired)) {
      return;
    }

    setCurrentChapter(clampNumber(desired, 1, totalChapters));
    setCurrentPageIndex(0);
    setActiveControlPanel(null);
    clearChromeTimer();
    setChromeVisible(false);
  };

  const handleGoToPageSubmit = (event) => {
    event.preventDefault();
    const desired = Number.parseInt(goToPageDraft, 10);
    if (Number.isNaN(desired)) return;

    const engine = paginationEngineRef.current;
    if (!engine) return;

    const targetIndex = Math.max(0, desired - 1);
    engine.precomputeThrough(targetIndex);
    const result = engine.ensurePage(targetIndex);
    if (!result.html) return;

    setCurrentPageIndex(targetIndex);
    setActiveControlPanel(null);
    clearChromeTimer();
    setChromeVisible(false);
  };

  const isAtEndOfChapter = Boolean(
    paginationDone
    && totalPages != null
    && totalPages > 0
    && currentPageIndex >= totalPages - 1,
  );

  const isPreviewOnly = availability === 'preview';
  const isAtEndOfBook = Boolean(book && isLastChapter && isAtEndOfChapter && !isPreviewOnly);

  useEffect(() => {
    if (!readerPositionStorageKey) return;
    if (chapters.length === 0) return;
    if (restoredSettingsForKeyRef.current === readerPositionStorageKey) return;
    if (restoreSnapshot) return;

    try {
      const raw = window.localStorage.getItem(readerPositionStorageKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const chapterNumber = clampNumber(Number(saved?.chapterNumber || 1), 1, totalChapters);

      const savedSettings = saved?.settings || null;
      if (savedSettings) {
        if (typeof savedSettings.fontSize === 'number') setFontSize(savedSettings.fontSize);
        if (typeof savedSettings.lineHeight === 'number') setLineHeight(savedSettings.lineHeight);
        if (typeof savedSettings.marginScale === 'number') setMarginScale(savedSettings.marginScale);
        if (typeof savedSettings.fontFamily === 'string') setFontFamily(savedSettings.fontFamily);
      }

      const desiredTheme = saved?.uiTheme || saved?.theme;
      if (desiredTheme && desiredTheme !== uiTheme) {
        onThemeChange?.(desiredTheme);
      }

      const anchor = saved?.reading_anchor || saved?.anchor || null;
      const pageIndexFallback = Math.max(0, Number(saved?.page_index ?? saved?.pageIndex ?? 0) || 0);

      setRestoreSnapshot({ chapterNumber, anchor, pageIndexFallback });
      setCurrentChapter(chapterNumber);
      restoredSettingsForKeyRef.current = readerPositionStorageKey;
    } catch (error) {
      console.warn('Failed to restore reading position:', error);
    }
  }, [chapters.length, onThemeChange, restoreSnapshot, readerPositionStorageKey, totalChapters, uiTheme]);

  const handleDeskNavigation = useCallback(() => {
    const fallbackToDesk = () => {
      window.location.assign('/#/desk');
    };

    try {
      navigate('/desk');
      window.setTimeout(() => {
        if (!window.location.hash.startsWith('#/desk')) {
          fallbackToDesk();
        }
      }, 180);
    } catch (error) {
      console.warn('Router navigation to Desk failed, using fallback URL.', error);
      fallbackToDesk();
    }
  }, [navigate]);

  const handleStartAgain = useCallback(() => {
    setRestoreSnapshot(null);
    setCurrentChapter(1);
    setCurrentPageIndex(0);
    setPageTurnDirection(null);
    setActiveControlPanel(null);
    updateReadingSession(resolvedBookId, 1, totalChapters);

    if (readerPositionStorageKey) {
      try {
        window.localStorage.removeItem(readerPositionStorageKey);
      } catch (error) {
        console.warn('Failed to reset reading position while starting again:', error);
      }
    }
  }, [readerPositionStorageKey, resolvedBookId, totalChapters]);

  useEffect(() => {
    const viewportEl = pageViewportRef.current;
    if (!viewportEl) return undefined;
    if (!chapterHtmlForPagination) return undefined;

    const layout = readerLayoutRef.current;
    if (!paginationEngineRef.current) {
      paginationEngineRef.current = new PaginationEngine({ viewportEl, layout });
    } else {
      paginationEngineRef.current.setViewportEl(viewportEl);
      paginationEngineRef.current.setLayout(layout);
    }

    paginationEngineRef.current.setChapterHtml(chapterHtmlForPagination);

    return () => {
      // Keep engine between chapter transitions; destroy on unmount.
    };
  }, [chapterHtmlForPagination]);

  useEffect(() => {
    const engine = paginationEngineRef.current;
    if (!engine) return;
    const boundary = engine.getPageStartBoundary?.(currentPageIndex);
    if (boundary) {
      lastKnownBoundaryRef.current = boundary;
    }
  }, [chapterHtmlForPagination, currentPageIndex]);

  useEffect(() => {
    const engine = paginationEngineRef.current;
    if (!engine) return;
    if (!chapterHtmlForPagination) return;
    if (restoreSnapshot) return;

    if (lastAppliedLayoutSignatureRef.current === readerLayoutSignature) return;
    lastAppliedLayoutSignatureRef.current = readerLayoutSignature;

    const anchor = lastKnownBoundaryRef.current || { blockIndex: 0, textOffset: 0 };
    engine.setLayout(readerLayoutRef.current);
    engine.resetPagination();
    const restoredIndex = engine.ensurePageIndexForBoundary(anchor);
    setCurrentPageIndex(restoredIndex);
  }, [chapterHtmlForPagination, restoreSnapshot, readerLayoutSignature]);

  useEffect(() => (
    () => paginationEngineRef.current?.destroy?.()
  ), []);

  useEffect(() => {
    if (!activeChapter) return;

    if (restoreSnapshot && restoreSnapshot.chapterNumber === clampedChapter) {
      const engine = paginationEngineRef.current;
      if (engine && restoreSnapshot.anchor) {
        engine.setLayout(readerLayoutRef.current);
        engine.resetPagination();
        const boundary = engine.boundaryFromReadingAnchor(restoreSnapshot.anchor);
        const restoredIndex = engine.ensurePageIndexForBoundary(boundary);
        setCurrentPageIndex(restoredIndex);
      } else {
        setCurrentPageIndex(Math.max(0, Number(restoreSnapshot.pageIndexFallback) || 0));
      }
      setRestoreSnapshot(null);
      return;
    }

    setCurrentPageIndex(0);
  }, [activeChapter, clampedChapter, restoreSnapshot]);

  useEffect(() => {
    const engine = paginationEngineRef.current;
    if (!engine) return;
    if (!chapterHtmlForPagination) return;

    const result = engine.ensurePage(currentPageIndex);
    if (!result.html && currentPageIndex > 0) {
      setCurrentPageIndex(0);
      return;
    }

    setCurrentPageHtml(result.html);
    setTotalPages(result.totalPages);
    setPaginationDone(result.isDone);
  }, [chapterHtmlForPagination, currentPageIndex, readerLayout]);

  useEffect(() => {
    const engine = paginationEngineRef.current;
    if (!engine) return undefined;

    const target = currentPageIndex + 1;
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(() => engine.precomputeThrough(target), { timeout: 600 });
      return () => window.cancelIdleCallback(handle);
    }

    const timeout = window.setTimeout(() => engine.precomputeThrough(target), 60);
    return () => window.clearTimeout(timeout);
  }, [chapterHtmlForPagination, currentPageIndex, readerLayout]);

  useEffect(() => {
    const engine = paginationEngineRef.current;
    if (!engine) return undefined;
    if (!chapterHtmlForPagination) return undefined;

    let cancelled = false;
    let handle = 0;

    const step = (deadline) => {
      if (cancelled) return;

      const budgetOk = !deadline || deadline.didTimeout || (typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() > 8);
      if (budgetOk) {
        engine.precomputeNextPages(2);
      }

      const total = engine.getTotalPagesIfKnown();
      if (total != null) {
        setTotalPages(total);
        setPaginationDone(true);
        return;
      }

      if (typeof window.requestIdleCallback === 'function') {
        handle = window.requestIdleCallback(step, { timeout: 900 });
      } else {
        handle = window.setTimeout(() => step({ didTimeout: true, timeRemaining: () => 50 }), 60);
      }
    };

    step();

    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === 'function' && handle) {
        window.cancelIdleCallback(handle);
      } else if (handle) {
        window.clearTimeout(handle);
      }
    };
  }, [chapterHtmlForPagination, readerLayoutSignature]);

  useEffect(() => {
    const viewportEl = pageViewportRef.current;
    const engine = paginationEngineRef.current;
    if (!viewportEl || !engine) return undefined;
    if (typeof ResizeObserver === 'undefined') return undefined;

    let lastWidth = 0;
    let lastHeight = 0;

    const resizeObserver = new ResizeObserver(() => {
      const rect = viewportEl.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      if (width === lastWidth && height === lastHeight) return;

      lastWidth = width;
      lastHeight = height;
      engine.setViewportEl(viewportEl);
      engine.resetPagination();
      setCurrentPageIndex(0);
    });

    resizeObserver.observe(viewportEl);
    return () => resizeObserver.disconnect();
  }, [chapterHtmlForPagination]);

  useEffect(() => {
    if (!readerPositionStorageKey) return;
    if (!activeChapter) return;

    const chapterId = activeChapter?._id || activeChapter?.id || activeChapter?.chapter_id || activeChapter?.index || clampedChapter;
    const engine = paginationEngineRef.current;
    const readingAnchor = engine?.getReadingAnchorForPageStart?.(currentPageIndex) || { paragraphIndex: 0, characterOffset: 0, blockIndex: 0, textOffset: 0 };

    try {
      window.localStorage.setItem(readerPositionStorageKey, JSON.stringify({
        book_id: resolvedBookId,
        chapter_id: chapterId,
        chapterNumber: clampedChapter,
        reading_anchor: readingAnchor,
        page_index: currentPageIndex,
        settings: {
          fontSize,
          fontFamily,
          lineHeight,
          marginScale,
        },
        uiTheme,
      }));
    } catch (error) {
      console.warn('Failed to persist reading position:', error);
    }
  }, [activeChapter, clampedChapter, currentPageIndex, fontFamily, fontSize, lineHeight, marginScale, readerPositionStorageKey, resolvedBookId, uiTheme]);

  useEffect(() => {
    if (isAtEndOfBook && book) {
      updateReadingSession(resolvedBookId, totalChapters, totalChapters, {
        progressPercent: 100,
        isFinished: true,
      });
    }
  }, [book, isAtEndOfBook, resolvedBookId, totalChapters]);

  useEffect(() => {
    if (book) {
      trackBookOpened(resolvedBookId);
      const chapterBaseProgress = ((clampedChapter - 1) / totalChapters) * 100;
      const inChapterProgress = (chapterPageProgress / totalChapters) * 100;
      const progressPercent = Math.max(0, Math.min(99, chapterBaseProgress + inChapterProgress));
      updateReadingSession(resolvedBookId, clampedChapter, totalChapters, {
        progressPercent,
        isFinished: false,
      });
    }
  }, [book, chapterPageProgress, clampedChapter, resolvedBookId, totalChapters]);


  useEffect(() => {
    if (!book || !resolvedBookId) return undefined;
    sessionStartedAtRef.current = Date.now();

    const interval = window.setInterval(() => {
      persistReadingProgress().catch(() => {});
    }, 10000);

    const flush = () => {
      persistReadingProgress({ useBeacon: true }).catch(() => {});
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };

    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', handleVisibility);
      flush();
    };
  }, [book, persistReadingProgress, resolvedBookId]);

  useEffect(() => {
    document.body.classList.add('is-reading-room');

    return () => {
      clearChromeTimer();
      document.body.classList.remove('is-reading-room');
    };
  }, [clearChromeTimer]);

  useEffect(() => {
    if (activeControlPanel) {
      clearChromeTimer();
      setChromeVisible(true);
      return;
    }

    scheduleChromeHide(1800);
  }, [activeControlPanel, clearChromeTimer, scheduleChromeHide]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (activeControlPanel) return;

      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.defaultPrevented) return;

      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        handleNextPage();
        return;
      }

      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        handlePrevPage();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { passive: false });
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeControlPanel, handleNextPage, handlePrevPage]);

  useEffect(() => {
    if (!pageTurnDirection) return undefined;
    const timeout = window.setTimeout(() => setPageTurnDirection(null), 220);
    return () => window.clearTimeout(timeout);
  }, [pageTurnDirection]);

  if (loading) return <div className="reader-loading-shell" aria-hidden="true" />;
  if (!book) return <div className="text-center p-10 mt-20">Book not found.</div>;
  if (contentError) return <div className="text-center p-10 mt-20">{contentErrorMessage}</div>;
  if (!activeChapter) return <div className="text-center p-10 mt-20">Book content not available.</div>;
  if (isPreviewOnly) {
    const raw = String(availabilityNote || '').trim();
    const lowered = raw.toLowerCase();
    const safeHint = raw && !(lowered.includes('source link') || lowered.includes('lending/preview'))
      ? raw.slice(0, 160)
      : '';

    return (
      <UnavailableBookState
        title={book?.title}
        author={book?.author}
        sourceUrl={book?.sourceUrl}
        sourceLabel={book?.source}
        hint={safeHint}
        onExternalClick={() => {}}
      />
    );
  }

  return (
    <div className={`reader-root theme-${uiTheme} animate-fade-in`}>
      <div className={`reader-toolbar ${chromeVisible ? 'is-visible' : ''} ${activeControlPanel ? 'settings-open' : ''}`}>
        <button type="button" onClick={handleDeskNavigation} className="back-btn">
          <ChevronLeft size={18} /> The Desk
        </button>

        <div className="reader-book-title">
          <span className="reader-book-name font-serif">{book.title}</span>
        </div>

        <div className="toolbar-actions">
          <button type="button" onClick={openGoTo} className="settings-btn" title="Navigate">
            <List size={17} />
          </button>

          <button
            type="button"
            onClick={() => setActiveControlPanel((prev) => (prev === 'settings' ? null : 'settings'))}
            className="settings-btn"
            title="Reading settings"
          >
            <Settings2 size={17} />
          </button>
        </div>
      </div>
      {isPartialContent && (
        <div className="text-center p-2">
          <p>Fetching remaining chapters…</p>
          <p className="text-sm opacity-80">
            {estimatedChapters ? `Estimated total chapters: ${estimatedChapters}.` : 'Additional chapters are available.'}
          </p>
          <button type="button" className="goto-submit" onClick={fetchMoreChapters} disabled={loadingMoreChapters}>
            {loadingMoreChapters ? 'Loading…' : 'Retry loading remaining chapters'}
          </button>
        </div>
      )}

      {activeControlPanel && (
        <div className="settings-backdrop" onClick={() => setActiveControlPanel(null)}>
          <div className="settings-panel glass-panel" onClick={(event) => event.stopPropagation()}>
            <div className="settings-panel-header">
              <div>
                <span className="settings-label">{activeControlPanel === 'goto' ? 'Navigate' : 'Reading settings'}</span>
                <h3 className="font-serif">{activeControlPanel === 'goto' ? 'Jump to chapter or page.' : 'Adjust your reading experience.'}</h3>
              </div>
              <button type="button" className="settings-close" onClick={() => setActiveControlPanel(null)}>
                Done
              </button>
            </div>

            {activeControlPanel === 'goto' && (
              <>
                <div className="settings-group">
                  <span className="settings-label">Go to chapter</span>
              <form className="goto-form" onSubmit={handleGoToSubmit}>
                <input
                  ref={goToInputRef}
                  className="goto-input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={totalChapters}
                  value={goToDraft}
                  onChange={(event) => setGoToDraft(event.target.value)}
                  aria-label="Go to chapter number"
                />
                <button type="submit" className="goto-submit">Go</button>
              </form>
            </div>

            <div className="settings-group">
              <span className="settings-label">Go to page</span>
              <form className="goto-form" onSubmit={handleGoToPageSubmit}>
                <input
                  ref={goToPageInputRef}
                  className="goto-input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={totalPages || undefined}
                  value={goToPageDraft}
                  onChange={(event) => setGoToPageDraft(event.target.value)}
                  aria-label="Go to page number"
                />
                <button type="submit" className="goto-submit">Go</button>
              </form>
            </div>

              </>
            )}

            {activeControlPanel === 'settings' && (
              <>
                <div className="settings-group">
                  <span className="settings-label">Theme</span>
                  <div className="theme-toggles">
                    {UI_THEMES.map((theme) => (
                      <button
                        key={theme.id}
                        type="button"
                        className={`theme-btn preview-${theme.id} ${uiTheme === theme.id ? 'active' : ''}`}
                        onClick={() => onThemeChange(theme.id)}
                      >
                        {theme.label}
                      </button>
                    ))}
                  </div>
                </div>

            <div className="settings-group">
              <span className="settings-label">Text size</span>
              <div className="font-size-toggles">
                <button type="button" onClick={() => setFontSize((size) => Math.max(0.96, Number((size - 0.05).toFixed(2))))}>A-</button>
                <span className="font-size-display">{Math.round(fontSize * 100)}%</span>
                <button type="button" onClick={() => setFontSize((size) => Math.min(1.35, Number((size + 0.05).toFixed(2))))}>A+</button>
              </div>
            </div>

            <div className="settings-group">
              <span className="settings-label">Line spacing</span>
              <div className="line-height-options">
                <button type="button" className={lineHeight === 1.66 ? 'active' : ''} onClick={() => setLineHeight(1.66)}>
                  Compact
                </button>
                <button type="button" className={lineHeight === 1.72 ? 'active' : ''} onClick={() => setLineHeight(1.72)}>
                  Book
                </button>
                <button type="button" className={lineHeight === 1.8 ? 'active' : ''} onClick={() => setLineHeight(1.8)}>
                  Open
                </button>
              </div>
            </div>

            <div className="settings-group">
              <span className="settings-label">Font</span>
              <div className="line-height-options">
                <button type="button" className={fontFamily === 'serif' ? 'active' : ''} onClick={() => setFontFamily('serif')}>
                  Serif
                </button>
                <button type="button" className={fontFamily === 'sans' ? 'active' : ''} onClick={() => setFontFamily('sans')}>
                  Sans
                </button>
              </div>
            </div>

            <div className="settings-group">
              <span className="settings-label">Margins</span>
              <div className="line-height-options">
                <button type="button" className={marginScale === 0.9 ? 'active' : ''} onClick={() => setMarginScale(0.9)}>
                  Narrow
                </button>
                <button type="button" className={marginScale === 1 ? 'active' : ''} onClick={() => setMarginScale(1)}>
                  Standard
                </button>
                <button type="button" className={marginScale === 1.1 ? 'active' : ''} onClick={() => setMarginScale(1.1)}>
                  Wide
                </button>
              </div>
            </div>

              </>
            )}

          </div>
        </div>
      )}

      <div
        className="reader-surface"
        onPointerDown={handleSurfacePointerDown}
        onPointerUp={handleSurfacePointerUp}
      >
        <PageRenderer
          viewportRef={pageViewportRef}
          html={currentPageHtml}
          pageTurnDirection={pageTurnDirection}
          style={{
            fontSize: `${fontSize}rem`,
            lineHeight,
            '--font-reading': readerLayout.fontFamily,
            '--reader-margin-scale': marginScale,
          }}
        />
      </div>

      {isAtEndOfBook && (
        <div className="finish-overlay animate-fade-in" role="dialog" aria-label="Finished book">
          <div className="finish-banner">
            <CheckCircle size={48} className="finish-icon" />
            <p className="finish-badge">Reading completed ✓</p>
            <h3>You've finished the book.</h3>
            <p>The story ends, but the conversation begins.</p>
            <p className="finish-book-meta">
              You finished:<br />
              <strong>{book.title}</strong>
              {book.author ? <> by {book.author}</> : null}
            </p>

            <div className="finish-actions">
              <Link to={nextBookPath} className="meet-people-btn">
                Continue to discussion <ArrowRight size={20} />
              </Link>
              <button type="button" className="btn-secondary" onClick={handleStartAgain}>
                Start Again <RotateCcw size={18} />
              </button>
              <button type="button" className="btn-secondary" onClick={handleDeskNavigation}>
                Back to Desk
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`reader-progress ${chromeVisible ? 'is-visible' : ''}`}>
        <div className="progress-info">
          <span>Chapter {clampedChapter} / {totalChapters}</span>
          <span>{progressPercent}%</span>
        </div>
        <div className="progress-bar-container">
          <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }} />
        </div>
      </div>

      <footer className="reader-footer" aria-label="Reading progress">
        <span>Chapter {clampedChapter} of {totalChapters}</span>
        {hasResolvedTotalPages && (
          <>
            <span className="footer-divider" aria-hidden="true">{'\u00B7'}</span>
            <span>Page {currentPageIndex + 1} of {resolvedTotalPages}</span>
          </>
        )}
      </footer>
    </div>
  );
};

export default ReadingRoom;
