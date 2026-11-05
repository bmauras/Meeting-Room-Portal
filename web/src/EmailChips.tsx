import { useId, useState } from 'react';

const EMAIL = /^[a-z0-9._%+'-]+@([a-z0-9-]+\.)+[a-z]{2,}$/i;

interface Props {
  label: string;
  value: string[];
  onChange: (emails: string[]) => void;
  /** Saisie en cours, non encore transformée en étiquette (gérée par le parent pour l'envoi du formulaire). */
  draft: string;
  onDraftChange: (text: string) => void;
  allowedDomains: string[];
  max: number;
  /** Adresse de l'utilisateur, déjà invité d'office. */
  self: string;
  hint: string;
}

/** Ajoute les adresses de `text` à `current` ; renvoie la liste et la première erreur rencontrée. */
export function addEmails(
  text: string,
  current: string[],
  { allowedDomains, max, self }: Pick<Props, 'allowedDomains' | 'max' | 'self'>,
): { emails: string[]; rest: string; error: string | null } {
  const anyDomain = allowedDomains.includes('*');
  const emails = [...current];
  const rejected: string[] = [];
  let error: string | null = null;
  for (const raw of text.split(/[\s,;]+/).filter(Boolean)) {
    const email = raw.toLowerCase();
    const domain = email.split('@')[1] ?? '';
    if (!EMAIL.test(email)) error ??= `« ${raw} » n’est pas une adresse e-mail valide.`;
    else if (!anyDomain && !allowedDomains.includes(domain)) error ??= `Le domaine ${domain} n’est pas autorisé.`;
    else if (email === self.toLowerCase()) error ??= 'Vous êtes déjà invité à cette réunion.';
    else if (emails.includes(email)) continue;
    else if (emails.length >= max) error ??= `${max} participants maximum.`;
    else {
      emails.push(email);
      continue;
    }
    rejected.push(raw);
  }
  return { emails, rest: rejected.join(' '), error };
}

/** Saisie d'adresses e-mail sous forme d'étiquettes, validées au fil de la frappe. */
export function EmailChips({ label, value, onChange, draft, onDraftChange, allowedDomains, max, self, hint }: Props) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [error, setError] = useState<string | null>(null);

  function commit(text: string) {
    const result = addEmails(text, value, { allowedDomains, max, self });
    onChange(result.emails);
    onDraftChange(result.rest);
    setError(result.error);
  }

  function remove(email: string) {
    onChange(value.filter((e) => e !== email));
    setError(null);
  }

  return (
    <div className="field">
      <label htmlFor={inputId}>
        {label} <span className="optional">facultatif</span>
      </label>
      <div className={`chips${error ? ' invalid' : ''}`} onClick={() => document.getElementById(inputId)?.focus()}>
        {value.map((email) => (
          <span key={email} className="chip">
            {email}
            <button type="button" aria-label={`Retirer ${email}`} onClick={() => remove(email)}>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        ))}
        <input
          id={inputId}
          type="email"
          inputMode="email"
          autoComplete="off"
          value={draft}
          placeholder={value.length ? '' : 'prenom.nom@exemple.com'}
          aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
          aria-invalid={Boolean(error)}
          disabled={value.length >= max}
          onChange={(e) => {
            const text = e.target.value;
            if (/[,;\s]$/.test(text)) commit(text);
            else {
              onDraftChange(text);
              if (error) setError(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault();
              commit(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) {
              remove(value[value.length - 1]!);
            }
          }}
          onBlur={() => draft.trim() && commit(draft)}
          onPaste={(e) => {
            e.preventDefault();
            commit(`${draft} ${e.clipboardData.getData('text')}`);
          }}
        />
      </div>
      <p id={hintId} className="hint">
        {hint} {value.length > 0 && `(${value.length}/${max})`}
      </p>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
