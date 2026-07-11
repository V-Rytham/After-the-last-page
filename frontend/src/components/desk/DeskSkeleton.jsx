import React from 'react';

// Counts mirror the desk's real layout (MAX_RECENT_ACTIVITY and the
// recommendation row) so the placeholder occupies the same footprint as the
// loaded content and there is no layout shift when it swaps in.
const RECENT_PLACEHOLDERS = 6;
const RECOMMENDATION_PLACEHOLDERS = 6;

/**
 * The desk's single loading state. Previously the hero, recent-activity row and
 * recommendations row each rendered their own skeleton under a separate
 * `role="status"` region even though one fetch drives all of them -- three
 * disconnected loaders (and three simultaneous announcements) for a single load.
 *
 * This renders the same shimmer blocks (identical `desk-skeleton*` / `card-row*`
 * classes, so the appearance and dimensions are unchanged) as ONE component
 * under ONE live region. The wrapper is `display: contents` so the sections stay
 * direct flex children of `.desk-shell` and the column gaps are preserved.
 */
const DeskSkeleton = ({ greeting }) => (
  <div className="desk-loading" role="status" aria-live="polite" aria-label="Loading your desk">
    <section className="desk-hero">
      <h2>{greeting}</h2>
      <div className="desk-skeleton desk-skeleton--hero" aria-hidden="true" />
    </section>

    <section className="desk-section">
      <div className="desk-section__heading">
        <h2>Recent activity</h2>
      </div>
      <div className="card-row card-row--recent" aria-hidden="true">
        {Array.from({ length: RECENT_PLACEHOLDERS }).map((_, index) => (
          <div key={`recent-skeleton-${index}`} className="desk-skeleton desk-skeleton--card" />
        ))}
      </div>
    </section>

    <section className="desk-section">
      <div className="desk-section__heading">
        <h2>Curating recommendations for you</h2>
        <p>Finding books matched to your reading history.</p>
      </div>
      <div className="card-row card-row--recommendations" aria-hidden="true">
        {Array.from({ length: RECOMMENDATION_PLACEHOLDERS }).map((_, index) => (
          <div key={`recommendation-skeleton-${index}`} className="desk-skeleton desk-skeleton--card" />
        ))}
      </div>
    </section>
  </div>
);

export default DeskSkeleton;
