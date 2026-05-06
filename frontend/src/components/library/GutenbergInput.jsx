import React, { useState } from 'react';

const GutenbergInput = ({ onSubmit, loading = false }) => {
  const [value, setValue] = useState('');
  const valid = /^\d+$/.test(String(value).trim());

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!valid || loading) return;
    onSubmit(String(value).trim());
  };

  return (
    <form className="library-gutenberg-form" onSubmit={handleSubmit}>
      <label htmlFor="gutenberg-entry" className="library-input-label">Enter Gutenberg ID</label>
      <div className="library-gutenberg-controls">
        <input
          id="gutenberg-entry"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="e.g. 1342"
          inputMode="numeric"
          autoComplete="off"
        />
        <button type="submit" disabled={!valid || loading}>{loading ? 'Opening…' : 'Open book'}</button>
      </div>
    </form>
  );
};

export default GutenbergInput;
