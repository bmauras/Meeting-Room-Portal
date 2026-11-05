import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  /** Texte d'accompagnement sous le titre. */
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  size?: 'small' | 'medium';
}

/**
 * Fenêtre modale fondée sur l'élément natif <dialog> : piège du focus, touche Échap et retour du
 * focus sur l'élément d'origine sont gérés par le navigateur.
 */
export function Dialog({ open, title, description, onClose, children, size = 'medium' }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOnBackdrop = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Focus sur le premier champ utile plutôt que sur le bouton de fermeture.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      // Fermeture au clic sur le fond, seulement si le clic y a commencé (pas lors d'une sélection de texte).
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (pressedOnBackdrop.current && e.target === ref.current) onClose();
        pressedOnBackdrop.current = false;
      }}
    >
      {open && (
        <div className="dialog-content">
          <header className="dialog-header">
            <div>
              <h2 id={titleId}>{title}</h2>
              {description && (
                <p id={descriptionId} className="muted">
                  {description}
                </p>
              )}
            </div>
            <button type="button" className="icon-button" aria-label="Fermer" onClick={onClose}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}
