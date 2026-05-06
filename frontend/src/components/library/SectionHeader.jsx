import React from 'react';

const SectionHeader = ({ title, showingLabel }) => (
  <header className="library-section-header">
    <h2>{title}</h2>
    <p>{showingLabel}</p>
  </header>
);

export default SectionHeader;
