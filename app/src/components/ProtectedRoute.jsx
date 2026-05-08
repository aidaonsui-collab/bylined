import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../store.jsx';

// Wrap any authenticated route. Sends unauthenticated visitors to /sign-in
// and remembers where they were headed so the post-login redirect lands
// them in the right place.
//
// Avoids flicker during the initial getSession() resolution by showing a
// minimal loading state instead of redirecting prematurely.
export default function ProtectedRoute({ children }) {
  const { isAuthed, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="route-loading" aria-busy="true">
        <div className="route-loading-pulse" />
      </div>
    );
  }

  if (!isAuthed) {
    return <Navigate to="/sign-in" state={{ from: location }} replace />;
  }

  return children;
}
