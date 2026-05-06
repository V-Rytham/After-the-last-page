import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { getBestCoverUrl } from '../../utils/openLibraryCovers';

const CurrentReadingCard = ({ book, session }) => {
  if (!book) {
    return (
      <article className="current-reading-card current-reading-card--empty">
        <p>Your reading journey starts here.</p>
        <p>Pick a book and make this space yours.</p>
        <Link to="/library" className="desk-btn desk-btn--primary-empty">
          Browse books <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </article>
    );
  }

  const totalPages = Math.max(0, Number(session?.totalPages || 0));
  const currentPage = Math.max(1, Number(session?.currentPage || 1));
  const hasSessionProgress = Number.isFinite(Number(session?.progressPercent));
  const sessionProgress = hasSessionProgress ? Number(session?.progressPercent) : null;
  const computedProgress = totalPages > 0 ? (currentPage / totalPages) * 100 : sessionProgress;
  const hasProgress = Number.isFinite(computedProgress);
  const progress = hasProgress
    ? Math.max(0, Math.min(100, Number(computedProgress)))
    : 0;
  const progressRounded = Math.round(progress);
  const route = book?.gutenbergId ? `/read/gutenberg/${book.gutenbergId}` : '/library';
  const coverUrl = getBestCoverUrl(book);
  const pageLabel = totalPages > 0 ? `Page ${currentPage} of ${totalPages}` : `Page ${currentPage}`;
  const fallbackInitial = String(book?.title || 'Book').trim().charAt(0).toUpperCase();

  return (
    <article className="current-reading-card">
      {coverUrl ? (
        <div className="current-reading-card__bg" aria-hidden="true">
          <img src={coverUrl} alt="" loading="lazy" decoding="async" />
        </div>
      ) : (
        <div className="current-reading-card__bg current-reading-card__bg--fallback" aria-hidden="true" />
      )}
      <div className="current-reading-card__overlay" aria-hidden="true" />
      <div className="current-reading-card__content">
        <div className="current-reading-card__layout">
          <div className="current-reading-card__main">
            <div className="current-reading-card__meta">
              <p className="current-reading-card__eyebrow">CONTINUE READING</p>
              <h3 title={book?.title || 'Untitled'}>{book?.title || 'Untitled'}</h3>
              <p title={book?.author || 'Unknown author'}>{book?.author || 'Unknown author'}</p>
            </div>
            <div className="current-reading-card__footer">
              <Link className="current-reading-card__resume" to={route}>
                Resume
              </Link>
              <div className="current-reading-card__progress-wrap">
                <div className="current-reading-card__progress-row">
                  <span>{pageLabel}</span>
                  {hasProgress ? <span>{progressRounded}%</span> : null}
                </div>
                {hasProgress ? (
                  <div
                    className="reading-progress"
                    role="progressbar"
                    aria-valuenow={progressRounded}
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-label="Reading progress"
                  >
                    <div style={{ width: `${progress}%` }} />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="current-reading-card__cover" aria-hidden="true">
            {coverUrl ? (
              <img src={coverUrl} alt="" loading="lazy" decoding="async" />
            ) : (
              <div className="current-reading-card__cover-fallback">{fallbackInitial || 'B'}</div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};

export default CurrentReadingCard;
