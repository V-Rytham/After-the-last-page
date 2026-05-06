import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AuthContext } from '../../context/AuthContext';

export default function PrivateRoute({ children }) {
  const location = useLocation();
  const { authLoading, currentUser } = React.useContext(AuthContext) || {};

  if (authLoading) {
    return <div className="route-skeleton route-skeleton--auth" aria-hidden="true" />;
  }

  if (!currentUser || currentUser.isAnonymous) {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }

  return children;
}
