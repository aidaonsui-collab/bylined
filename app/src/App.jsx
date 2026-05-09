import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './store.jsx';
import { ToastProvider } from './components/Toast.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';

import SignUp from './pages/SignUp.jsx';
import SignIn from './pages/SignIn.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import AuthCallback from './pages/AuthCallback.jsx';
import CheckEmail from './pages/CheckEmail.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Pricing from './pages/Pricing.jsx';
import Billing from './pages/Billing.jsx';
import Sites from './pages/Sites.jsx';
import Usage from './pages/Usage.jsx';
import Voice from './pages/Voice.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            {/* Auth */}
            <Route path="/sign-up" element={<SignUp />} />
            <Route path="/sign-in" element={<SignIn />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/auth/reset" element={<ResetPassword />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/auth/check-email" element={<CheckEmail />} />

            {/* App (protected) */}
            <Route
              path="/app/pricing"
              element={
                <ProtectedRoute>
                  <Pricing />
                </ProtectedRoute>
              }
            />
            <Route
              path="/app/billing"
              element={
                <ProtectedRoute>
                  <Billing />
                </ProtectedRoute>
              }
            />
            <Route
              path="/app/sites"
              element={
                <ProtectedRoute>
                  <Sites />
                </ProtectedRoute>
              }
            />
            <Route
              path="/app/usage"
              element={
                <ProtectedRoute>
                  <Usage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/app/voice"
              element={
                <ProtectedRoute>
                  <Voice />
                </ProtectedRoute>
              }
            />
            <Route
              path="/app/*"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />

            {/* Root → app (will redirect to sign-in if unauthed) */}
            <Route path="/" element={<Navigate to="/app" replace />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
