import { addDays, isValidDate, isWeekend, toMinutes } from './time.js';

export interface BookingRules {
  timeZone: string;
  dayStart: string;
  dayEnd: string;
  slotMinutes: number;
  maxDurationMinutes: number;
  horizonDays: number;
  allowWeekends: boolean;
  allowedAttendeeDomains: string[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;
const EMAIL = /^[a-z0-9._%+'-]+@([a-z0-9-]+\.)+[a-z]{2,}$/;
const MAX_ATTENDEES = 10;

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

/** Valide un créneau. `now` est l'heure locale courante ('YYYY-MM-DDTHH:mm'). Retourne un message d'erreur ou null. */
export function validateSlot(start: string, end: string, rules: BookingRules, now: string): string | null {
  const s = LOCAL_DATETIME.exec(start);
  const e = LOCAL_DATETIME.exec(end);
  if (!s || !e) return 'Format de date invalide.';
  const [, startDate, startTime] = s as unknown as [string, string, string];
  const [, endDate, endTime] = e as unknown as [string, string, string];

  if (!isValidDate(startDate) || !isValidDate(endDate)) return 'Date invalide.';
  if (startDate !== endDate) return 'La réservation doit commencer et finir le même jour.';

  const startMin = toMinutes(startTime);
  const endMin = toMinutes(endTime);
  if (Number.isNaN(startMin) || Number.isNaN(endMin)) return 'Heure invalide.';
  if (startMin % rules.slotMinutes !== 0 || endMin % rules.slotMinutes !== 0) {
    return `Les horaires doivent être des multiples de ${rules.slotMinutes} minutes.`;
  }
  if (endMin <= startMin) return "L'heure de fin doit être après l'heure de début.";
  if (endMin - startMin > rules.maxDurationMinutes) {
    return `Durée maximale : ${formatDuration(rules.maxDurationMinutes)}.`;
  }
  if (startMin < toMinutes(rules.dayStart) || endMin > toMinutes(rules.dayEnd)) {
    return `Les salles sont réservables de ${rules.dayStart} à ${rules.dayEnd}.`;
  }
  if (!rules.allowWeekends && isWeekend(startDate)) return 'Les réservations le week-end ne sont pas autorisées.';
  if (start <= now) return 'Le créneau doit être dans le futur.';
  if (startDate > addDays(now.slice(0, 10), rules.horizonDays)) {
    return `Les réservations sont possibles jusqu'à ${rules.horizonDays} jours à l'avance.`;
  }
  return null;
}

/**
 * L'objet saisi par un externe apparaît dans des calendriers internes : on le réduit à du texte
 * simple, sans lien ni balise, pour qu'il ne puisse pas servir de vecteur de phishing.
 */
export function sanitizeSubject(raw: string): Result<string> {
  const value = raw
    .normalize('NFKC')
    // Caractères de contrôle, zero-width et overrides bidirectionnels.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (value.length < 3) return { ok: false, error: "L'objet doit contenir au moins 3 caractères." };
  if (value.length > 80) return { ok: false, error: "L'objet ne doit pas dépasser 80 caractères." };
  if (/[<>]/.test(value)) return { ok: false, error: "Les caractères < et > ne sont pas autorisés dans l'objet." };
  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\/)/i.test(value)) {
    return { ok: false, error: "Les liens ne sont pas autorisés dans l'objet." };
  }
  return { ok: true, value };
}

/**
 * Participants additionnels : limités aux domaines autorisés pour que le portail ne puisse pas
 * servir à envoyer des invitations depuis notre domaine vers des adresses arbitraires.
 * « * » lève cette restriction (le nombre de participants et le rate limiting restent bornés).
 */
export function normalizeAttendees(raw: string[], rules: BookingRules, bookerEmail: string): Result<string[]> {
  const anyDomain = rules.allowedAttendeeDomains.includes('*');
  const unique = new Set<string>();
  for (const entry of raw) {
    const email = entry.trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL.test(email)) return { ok: false, error: `Adresse e-mail invalide : ${email.slice(0, 80)}` };
    const domain = email.split('@')[1] ?? '';
    if (!anyDomain && !rules.allowedAttendeeDomains.includes(domain)) {
      return { ok: false, error: `Le domaine ${domain} n'est pas autorisé pour les participants.` };
    }
    if (email !== bookerEmail.toLowerCase()) unique.add(email);
  }
  if (unique.size > MAX_ATTENDEES) return { ok: false, error: `${MAX_ATTENDEES} participants maximum.` };
  return { ok: true, value: [...unique] };
}

export function isEmail(value: string): boolean {
  return EMAIL.test(value.toLowerCase());
}
