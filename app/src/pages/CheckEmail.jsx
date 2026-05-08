import { Link, useLocation } from 'react-router-dom';
import AuthLayout from '../components/AuthLayout.jsx';

export default function CheckEmail() {
  const location = useLocation();
  const email = location.state?.email;

  return (
    <AuthLayout
      eyebrow="Confirm your account"
      title="Check your inbox."
      lede={
        email
          ? `We just emailed a confirmation link to ${email}. Click it to finish setting up your account.`
          : 'We just emailed a confirmation link. Click it to finish setting up your account.'
      }
      footer={<Link to="/sign-in">Back to sign in</Link>}
    >
      <p className="auth-fineprint">
        Didn't get it? Check spam or wait a minute — sometimes email is slow.
      </p>
    </AuthLayout>
  );
}
