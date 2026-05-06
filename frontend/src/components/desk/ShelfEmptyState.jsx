import React from 'react';
import { Link } from 'react-router-dom';
import { BookMarked } from 'lucide-react';

const ShelfEmptyState = () => (
  <div className="shelf-empty" role="status">
    <BookMarked size={22} aria-hidden="true" />
    <h3>Your shelf is empty</h3>
    <p>Start adding books you love to build your collection.</p>
    <Link to="/library" className="desk-btn">Browse Books</Link>
  </div>
);

export default ShelfEmptyState;
