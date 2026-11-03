import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { Portal } from './Portal';

const LOGIN_ERRORS: Record<string, string> = {
  signin: 'La connexion a échoué. Veuillez réessayer.',
  forbidden:
    "Votre compte n'est pas autorisé à utiliser ce portail. Contactez votre interlocuteur habituel pour obtenir l'accès.",
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

  if (error) return <Centered>{error}</Centered>;
  if (me === undefined) return <Centered>Chargement…</Centered>;
  if (me === null) return <Login />;
  return <Portal me={me} />;
}

function Login() {
  const code = new URLSearchParams(window.location.search).get('error');
  const message = code ? LOGIN_ERRORS[code] ?? LOGIN_ERRORS.signin : null;
  return (
    <main className="login">
      <div className="card login-card">
        <h1>Réservation de salles de réunion</h1>
        <p>Connectez-vous avec votre compte professionnel Microsoft 365 pour réserver une salle.</p>
        {message && <p className="alert alert-error">{message}</p>}
        <a className="button button-primary" href="/auth/login">
          Se connecter
        </a>
      </div>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="login">{children}</main>;
}
