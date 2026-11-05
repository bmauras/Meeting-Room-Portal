import { useCallback, useState } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}

let nextId = 1;

/** Notifications éphémères ; les erreurs restent affichées plus longtemps. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const notify = useCallback(
    (tone: ToastTone, title: string, message?: string) => {
      const id = nextId++;
      setToasts((list) => [...list.slice(-2), { id, tone, title, message }]);
      window.setTimeout(() => dismiss(id), tone === 'error' ? 12_000 : 7_000);
    },
    [dismiss],
  );
  return { toasts, notify, dismiss };
}

const ICONS: Record<ToastTone, string> = {
  success: 'M5 12.5l4.5 4.5L19 7.5',
  error: 'M12 7v6m0 4h.01',
  info: 'M12 11v6m0-10h.01',
};

export function ToastRegion({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <>
      {/* Deux régions : les erreurs sont annoncées immédiatement, le reste poliment. */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.filter((t) => t.tone !== 'error').map((t) => (
          <ToastItem key={t.id} toast={t} dismiss={dismiss} />
        ))}
      </div>
      <div className="toasts toasts-errors" role="alert" aria-live="assertive">
        {toasts.filter((t) => t.tone === 'error').map((t) => (
          <ToastItem key={t.id} toast={t} dismiss={dismiss} />
        ))}
      </div>
    </>
  );
}

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  return (
    <div className={`toast toast-${toast.tone}`}>
      <svg className="toast-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15" />
        <path d={ICONS[toast.tone]} stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="toast-body">
        <strong>{toast.title}</strong>
        {toast.message && <p>{toast.message}</p>}
      </div>
      <button type="button" className="icon-button" aria-label="Fermer la notification" onClick={() => dismiss(toast.id)}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
