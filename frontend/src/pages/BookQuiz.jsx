import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, RefreshCw } from 'lucide-react';
import api from '../utils/api';
import './BookQuiz.css';

const QUIZ_STORE_PREFIX = 'bookQuiz:';

const withTimeout = async (fn, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
};

const normalizeQuestions = (payload) => {
  const questions = Array.isArray(payload?.questions)
    ? payload.questions
    : (Array.isArray(payload?.data?.questions) ? payload.data.questions : []);

  return questions.slice(0, 5).map((q) => ({
    question: String(q?.question || '').trim(),
    options: Array.isArray(q?.options) ? q.options.map((opt) => String(opt)) : [],
  }));
};

const isValidQuiz = (questions) => (
  Array.isArray(questions)
  && questions.length === 5
  && questions.every((q) => q?.question && Array.isArray(q.options) && q.options.length >= 2)
);

const parseRetryAfterMs = (err, fallbackMs = 3000) => {
  const retryAfterHeader = Number(err?.response?.headers?.['retry-after'] || 0);
  const retryAfterBody = Number(err?.response?.data?.retryAfter || 0);
  const retryAfterSeconds = Math.max(retryAfterHeader, retryAfterBody, 0);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(30_000, retryAfterSeconds * 1000);
  }

  return fallbackMs;
};

const readStoredQuiz = (bookId) => {
  const raw = sessionStorage.getItem(`${QUIZ_STORE_PREFIX}${bookId}`);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const ageMs = Date.now() - Number(parsed?.fetchedAt || 0);
    if (!Number.isFinite(ageMs) || ageMs > 30 * 60 * 1000) {
      return null;
    }

    if (!isValidQuiz(parsed?.questions)) {
      return null;
    }

    return {
      questions: parsed.questions,
      answers: Array.isArray(parsed.answers) ? parsed.answers : new Array(5).fill(null),
      jobId: typeof parsed.jobId === 'string' ? parsed.jobId : null,
      fetchedAt: parsed.fetchedAt,
    };
  } catch {
    return null;
  }
};

const writeStoredQuiz = (bookId, next) => {
  sessionStorage.setItem(`${QUIZ_STORE_PREFIX}${bookId}`, JSON.stringify(next));
};

export default function BookQuiz() {
  const { bookId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const nextPath = location.state?.from || location.state?.next || `/meet/${bookId}`;

  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState(() => new Array(5).fill(null));
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [processingMessage, setProcessingMessage] = useState('');
  const [quizJobId, setQuizJobId] = useState(null);
  const [quizJobProgress, setQuizJobProgress] = useState(0);
  const isMountedRef = useRef(true);
  const fetchInFlightRef = useRef(false);
  const processingStartRef = useRef(null);
  const retryTimerRef = useRef(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  const statusCopy = useCallback((stage, progress) => {
    const normalized = String(stage || '').toLowerCase();
    if (normalized === 'analyzing') return 'Analyzing book content\u2026';
    if (normalized === 'generating') return 'Generating meaningful questions\u2026';
    if (normalized === 'finalizing') return 'Finalizing your quiz\u2026';
    if (Number.isFinite(progress) && progress > 0.5) return 'Preparing your quiz\u2026';
    return 'Warming up your quiz\u2026';
  }, []);

  const checkExistingAccess = useCallback(async () => {
    try {
      const { data } = await api.get(`/access/check?bookId=${encodeURIComponent(bookId)}`);
      if (data?.access) {
        navigate(nextPath, { replace: true });
        return true;
      }
    } catch {
      // ignore access check failures; quiz will still render
    }

    return false;
  }, [bookId, navigate, nextPath]);

  const fetchQuiz = useCallback(async ({ force = false } = {}) => {
    if (!bookId || fetchInFlightRef.current) {
      return;
    }

    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    fetchInFlightRef.current = true;
    setLoading(true);
    setError('');
    setResult(null);
    setProcessingMessage('');
    setQuizJobProgress(0);

    const cached = readStoredQuiz(bookId);
    if (cached) {
      processingStartRef.current = null;
      setQuestions(cached.questions);
      setAnswers(cached.answers);
      setQuizJobId(cached.jobId || null);
      setLoading(false);
      fetchInFlightRef.current = false;
      return;
    }

    try {
      if (!processingStartRef.current) {
        processingStartRef.current = Date.now();
      }

      const { data: startData } = await withTimeout(
        (signal) => api.post('/quiz/start', { bookId, force }, { signal }),
        12000,
      );

      const jobId = startData?.jobId || startData?.job_id || null;
      if (!jobId) {
        throw new Error('Quiz service did not return a job id.');
      }

      setQuizJobId(jobId);
      setProcessingMessage(statusCopy(startData?.stage, startData?.progress));

      let pollAttempt = 0;
      const schedulePoll = (delayMs) => {
        fetchInFlightRef.current = false;
        retryTimerRef.current = window.setTimeout(() => poll(), delayMs);
      };

      const poll = async () => {
        const elapsed = Date.now() - Number(processingStartRef.current || Date.now());
        if (elapsed > 2 * 60_000) {
          processingStartRef.current = null;
          if (isMountedRef.current) {
            setLoading(false);
            setError('Quiz is taking longer than expected. You can retry, or continue to Meet.');
          }
          fetchInFlightRef.current = false;
          return;
        }

        try {
          const { data } = await api.get(`/quiz/status/${encodeURIComponent(jobId)}`);
          const progress = Number(data?.progress || 0);
          if (isMountedRef.current) {
            setQuizJobProgress(Number.isFinite(progress) ? progress : 0);
            setProcessingMessage(statusCopy(data?.stage, progress));
          }

          if (data?.status === 'failed') {
            processingStartRef.current = null;
            if (isMountedRef.current) {
              setLoading(false);
              setError(data?.error?.message || 'Quiz generation failed. Please retry.');
            }
            fetchInFlightRef.current = false;
            return;
          }

          if (data?.status !== 'completed') {
            pollAttempt += 1;
            const nextDelay = Math.min(7000, 1800 + (pollAttempt * 400));
            schedulePoll(nextDelay);
            return;
          }

          const { data: resultData } = await api.get(`/quiz/result/${encodeURIComponent(jobId)}`);
          processingStartRef.current = null;

          const normalized = normalizeQuestions(resultData);
          if (!isValidQuiz(normalized)) {
            throw new Error('Quiz service returned malformed questions.');
          }

          const nextState = {
            questions: normalized,
            answers: new Array(5).fill(null),
            jobId,
            fetchedAt: Date.now(),
          };

          if (isMountedRef.current) {
            setQuestions(normalized);
            setAnswers(nextState.answers);
            writeStoredQuiz(bookId, nextState);
            setLoading(false);
          }
        } catch (err) {
          const status = Number(err?.statusCode || err?.response?.status || 0);
          if (status === 429) {
            const retryAfterMs = parseRetryAfterMs(err, Math.min(12_000, 3000 + (pollAttempt * 600)));
            if (isMountedRef.current) {
              setProcessingMessage('Quiz engine is busy. Waiting before next status check…');
            }
            pollAttempt += 1;
            schedulePoll(retryAfterMs);
            return;
          }

          processingStartRef.current = null;
          const message = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'Failed to load quiz.';
          if (isMountedRef.current) {
            setLoading(false);
            setError(message);
          }
        } finally {
          fetchInFlightRef.current = false;
        }
      };

      schedulePoll(1500);
    } catch (err) {
      processingStartRef.current = null;
      setLoading(false);
      const isTimeout = err?.name === 'AbortError' || err?.code === 'ERR_CANCELED';
      const message = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'Failed to load quiz.';
      setError(isTimeout ? 'Quiz request timed out. Please retry.' : message);
    } finally {
      fetchInFlightRef.current = false;
    }
  }, [bookId, statusCopy]);

  const handleContinueToMeet = () => {
    navigate(`/meet/${bookId}`, { replace: true });
  };

  useEffect(() => {
    if (!bookId) {
      setError('Missing bookId.');
      setLoading(false);
      return;
    }

    checkExistingAccess().then((alreadyAllowed) => {
      if (!alreadyAllowed) {
        fetchQuiz();
      }
    });
  }, [bookId, checkExistingAccess, fetchQuiz]);

  const handleSelect = (questionIndex, optionIndex) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[questionIndex] = optionIndex;
      writeStoredQuiz(bookId, {
        questions,
        answers: next,
        jobId: quizJobId,
        fetchedAt: Date.now(),
      });
      return next;
    });
  };

  const canSubmit = !loading && isValidQuiz(questions) && answers.every((value) => Number.isInteger(value));

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit || submitting) {
      return;
    }

    setSubmitting(true);
    setError('');
    setResult(null);

    try {
      const { data } = await api.post('/quiz/submit', {
        bookId,
        answers,
        jobId: quizJobId,
      });

      setResult({ passed: Boolean(data?.passed), score: Number(data?.score || 0) });

      if (data?.passed) {
        sessionStorage.removeItem(`${QUIZ_STORE_PREFIX}${bookId}`);
        navigate(nextPath, { replace: true });
        return;
      }
    } catch (err) {
      const message = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'Failed to submit quiz.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="quiz-page animate-fade-in">
      <header className="quiz-hero glass-panel">
        <h1 className="font-serif">Quick book quiz</h1>
        <p>Answer 5 questions to generate better discussion prompts for this book.</p>
      </header>

      {loading && (
        <div className="quiz-state glass-panel" role="status">
          <div style={{ display: 'grid', gap: '0.4rem' }}>
            <div>{processingMessage || 'Loading quiz\u2026'}</div>
            {quizJobProgress > 0 ? (
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.92rem' }}>
                {Math.round(Math.min(1, quizJobProgress) * 100)}%
              </div>
            ) : null}
          </div>
        </div>
      )}

      {loading && (
        <div className="quiz-skeleton" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="quiz-skeleton-card">
              <div className="quiz-skeleton-line" style={{ width: index === 0 ? '62%' : (index === 1 ? '54%' : '58%') }} />
              <div className="quiz-skeleton-stack">
                <div className="quiz-skeleton-line sm" style={{ width: '92%' }} />
                <div className="quiz-skeleton-line sm" style={{ width: '86%' }} />
                <div className="quiz-skeleton-line sm" style={{ width: '78%' }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {loading && processingMessage && (
        <div className="quiz-actions">
          <button type="button" className="btn-secondary" onClick={handleContinueToMeet}>Continue to Meet</button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/desk')}>
            Back to Desk
          </button>
        </div>
      )}

      {!loading && error && (
        <div className="quiz-state glass-panel is-error" role="alert">
          <div className="quiz-error-title">
            <AlertTriangle size={18} />
            <span>Quiz unavailable</span>
          </div>
          <p>{error}</p>
          <div className="quiz-actions">
            <button type="button" className="btn-primary" onClick={() => fetchQuiz({ force: true })}>
              <RefreshCw size={16} /> Retry
            </button>
            <button type="button" className="btn-secondary" onClick={handleContinueToMeet}>Continue to Meet</button>
            <button type="button" className="btn-secondary" onClick={() => navigate('/desk')}>
              Back to Desk
            </button>
          </div>
        </div>
      )}

      {!loading && !error && isValidQuiz(questions) && (
        <form className="quiz-form" onSubmit={handleSubmit}>
          {questions.map((q, qIndex) => (
            <article key={`${qIndex}-${q.question.slice(0, 24)}`} className="quiz-card glass-panel">
              <h2 className="quiz-question font-serif">{qIndex + 1}. {q.question}</h2>
              <div className="quiz-options" role="radiogroup" aria-label={`Question ${qIndex + 1}`}>
                {q.options.map((opt, optIndex) => {
                  const selected = answers[qIndex] === optIndex;
                  return (
                    <button
                      key={`${qIndex}-${optIndex}`}
                      type="button"
                      className={`quiz-option ${selected ? 'selected' : ''}`}
                      onClick={() => handleSelect(qIndex, optIndex)}
                      aria-pressed={selected}
                    >
                      <span className="quiz-option-letter">{String.fromCharCode(65 + optIndex)}</span>
                      <span className="quiz-option-text">{opt}</span>
                    </button>
                  );
                })}
              </div>
            </article>
          ))}

          {result && !result.passed && (
            <div className="quiz-state glass-panel is-warning" role="status">
              <strong>Not quite.</strong> Score: {result.score}%. You can retry.
            </div>
          )}

          <div className="quiz-submit-row">
            <button type="submit" className="btn-primary" disabled={!canSubmit || submitting}>
              {submitting ? 'Submitting\u2026' : (<><span>Submit answers</span> <ArrowRight size={16} /></>)}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => fetchQuiz({ force: true })}
              disabled={submitting}
            >
              Reload quiz
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
