import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { Portal } from './Portal';

const LOGIN_ERRORS: Record<string, { title: string; message: string }> = {
  signin: { title: 'La connexion a échoué', message: 'Veuillez réessayer. Si le problème persiste, fermez votre navigateur puis reconnectez-vous.' },
  forbidden: {
    title: 'Accès non autorisé',
    message: 'Votre compte n’est pas habilité à utiliser ce portail. Contactez votre interlocuteur habituel pour obtenir l’accès.',
  },
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setMe(null);
        else setError(err instanceof Error ? err.message : 'Erreur inattendue.');
      });
  }, []);

  if (error) {
    return (
      <main className="login">
        <div className="card login-card" role="alert">
          <h1>Service momentanément indisponible</h1>
          <p className="muted">{error}</p>
          <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
            Réessayer
          </button>
        </div>
      </main>
    );
  }
  if (me === undefined) {
    return (
      <main className="login" aria-busy="true">
        <span className="spinner spinner-large" role="status" aria-label="Chargement" />
      </main>
    );
  }
  if (me === null) return <Login />;
  return <Portal me={me} />;
}

function Login() {
  const code = new URLSearchParams(window.location.search).get('error');
  const problem = code ? (LOGIN_ERRORS[code] ?? LOGIN_ERRORS.signin) : null;
  return (
    <main className="login">
      <div className="card login-card">
        <svg className="logo logo-large" viewBox="0 0 32 32" width="48" height="48" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="currentColor" />
          <rect x="8" y="9" width="16" height="15" rx="2.5" fill="none" stroke="#fff" strokeWidth="2" />
          <path d="M8 14h16M12.5 7v4M19.5 7v4" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <h1>Réservation de salles de réunion</h1>
        <p className="muted">Consultez les disponibilités et réservez une salle, avec réunion Teams incluse.</p>
        {problem && (
          <div className="callout callout-error" role="alert">
            <p>
              <strong>{problem.title}</strong>
            </p>
            <p>{problem.message}</p>
          </div>
        )}
        <a className="button button-primary button-large" href="/auth/login">
          <svg viewBox="0 0 21 21" width="18" height="18" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
          Se connecter avec Microsoft
        </a>
        <p className="muted small">Utilisez votre compte professionnel Microsoft 365 habituel.</p>
      </div>
    </main>
  );
}
