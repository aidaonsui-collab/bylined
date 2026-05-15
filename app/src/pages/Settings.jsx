// Settings — account profile + password.
//
// Display name writes to public.profiles via the store's updateProfile
// (RLS update_own_profile permits it). Password goes through
// supabase.auth.updateUser. Account email is read-only here — changing
// the email of record is a Supabase Auth flow we haven't wired, and
// for billing it's managed through the Stripe portal.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';

const PASSWORD_MIN = 8;

const Logo = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4 L8 12 L14 20" />
    <circle cx="14" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="14" cy="20" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export default function Settings() {
  const { user, profile, signOut, updateProfile, updatePassword } = useAuth();
  const toast = useToast();

  // The profile loads async in the auth store — it can still be null on
  // first render. Seed the field once it arrives (and only while the
  // user hasn't started typing, so we don't clobber an in-progress edit).
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [nameTouched, setNameTouched] = useState(false);
  useEffect(() => {
    if (!nameTouched && profile?.full_name) {
      setFullName(profile.full_name);
    }
  }, [profile?.full_name, nameTouched]);

  const [savingName, setSavingName] = useState(false);

  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  const nameDirty = fullName.trim() !== (profile?.full_name ?? '').trim();

  const handleSaveName = async (e) => {
    e.preventDefault();
    if (!nameDirty || fullName.trim().length < 2) {
      toast('Name needs at least 2 characters.', { tone: 'warn' });
      return;
    }
    setSavingName(true);
    const result = await updateProfile({ full_name: fullName });
    setSavingName(false);
    if (!result.ok) {
      toast(result.error || 'Could not save.', { tone: 'danger' });
      return;
    }
    toast('Name updated.', { tone: 'success' });
  };

  const handleSavePassword = async (e) => {
    e.preventDefault();
    if (pw.length < PASSWORD_MIN) {
      toast(`Password needs ${PASSWORD_MIN}+ characters.`, { tone: 'warn' });
      return;
    }
    if (pw !== pw2) {
      toast('Passwords do not match.', { tone: 'warn' });
      return;
    }
    setSavingPw(true);
    const result = await updatePassword(pw);
    setSavingPw(false);
    if (!result.ok) {
      toast(result.error || 'Could not update password.', { tone: 'danger' });
      return;
    }
    setPw('');
    setPw2('');
    toast('Password updated.', { tone: 'success' });
  };

  return (
    <div className="app-shell">
      <header className="app-nav">
        <div className="app-nav-inner">
          <Link to="/app" className="app-brand">
            <span className="brand-mark"><Logo /></span>
            <span className="brand-wm">bylined</span>
          </Link>
          <nav className="app-nav-links">
            <Link to="/app">Articles</Link>
            <Link to="/app/sites">Sites</Link>
            <Link to="/app/voice">Voice</Link>
            <Link to="/app/usage">Usage</Link>
            <Link to="/app/billing">Billing</Link>
          </nav>
          <div className="app-nav-user">
            <Link to="/app/settings" className="app-nav-email">{user?.email}</Link>
            <button type="button" className="btn btn-sm btn-ghost" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="app-container" style={{ maxWidth: 560 }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Settings</div>
          <h1 className="app-h1 serif" style={{ fontSize: 44 }}>Account</h1>

          {/* ─── Profile ─────────────────────────────────────── */}
          <form
            onSubmit={handleSaveName}
            className="app-callout"
            style={{ flexDirection: 'column', alignItems: 'stretch', gap: 14, marginTop: 32 }}
          >
            <div className="eyebrow">Profile</div>

            <label className="field">
              <span className="field-label">Display name</span>
              <input
                className="input"
                type="text"
                value={fullName}
                onChange={(e) => {
                  setNameTouched(true);
                  setFullName(e.target.value);
                }}
                placeholder="Your name"
                maxLength={80}
                disabled={savingName}
              />
            </label>

            <label className="field">
              <span className="field-label">Account email</span>
              <input
                className="input"
                type="email"
                value={user?.email ?? ''}
                disabled
                readOnly
              />
              <span style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
                Email of record. Manage billing email from the{' '}
                <Link to="/app/billing">billing portal</Link>.
              </span>
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!nameDirty || savingName}
              >
                {savingName ? 'Saving…' : 'Save profile'}
              </button>
            </div>
          </form>

          {/* ─── Password ────────────────────────────────────── */}
          <form
            onSubmit={handleSavePassword}
            className="app-callout"
            style={{ flexDirection: 'column', alignItems: 'stretch', gap: 14, marginTop: 16 }}
          >
            <div className="eyebrow">Password</div>

            <label className="field">
              <span className="field-label">New password</span>
              <input
                className="input"
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder={`At least ${PASSWORD_MIN} characters`}
                autoComplete="new-password"
                disabled={savingPw}
              />
            </label>

            <label className="field">
              <span className="field-label">Confirm new password</span>
              <input
                className="input"
                type="password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                placeholder="Re-enter it"
                autoComplete="new-password"
                disabled={savingPw}
              />
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!pw || !pw2 || savingPw}
              >
                {savingPw ? 'Updating…' : 'Update password'}
              </button>
            </div>
          </form>

          <p className="app-fineprint" style={{ marginTop: 24, fontSize: 12.5, color: 'var(--fg-subtle)' }}>
            Need to delete your account or export your data? Email{' '}
            <a href="mailto:hi@bylined.so">hi@bylined.so</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
