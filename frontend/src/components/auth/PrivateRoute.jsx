import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AuthContext } from '../../context/AuthContext';

export default function PrivateRoute({ children }) {
  const location = useLocation();
  const { authLoading, currentUser } = React.useContext(AuthContext) || {};

  if (authLoading) {
    return <div className="loading">Loading…</div>;
  }

  if (!currentUser || currentUser.isAnonymous) {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }

  return children;
}
