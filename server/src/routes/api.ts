import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { SessionUser } from '../authz.js';
import type { BookingService } from '../bookings.js';
import type { Config } from '../config.js';
import { clientIp, requireSameOrigin, wrap } from '../http.js';
import type { RoomService } from '../rooms.js';
import type { BookingRules } from '../rules.js';
import type { Sessions } from '../session.js';
import { addDays, isValidDate, nowLocal } from '../time.js';

export function apiRouter(deps: { config: Config; sessions: Sessions; rooms: RoomService; bookings: BookingService; rules: BookingRules }): Router {
  const { config, sessions, rooms, bookings, rules } = deps;
  const router = Router();
  const userOf = (res: { locals: Record<string, unknown> }) => res.locals.user as SessionUser;

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireSameOrigin(config.PUBLIC_BASE_URL));
  router.use(
    wrap(async (req, res, next) => {
      const session = await sessions.user(req, res);
      if (!session.user) return res.status(401).json({ error: 'Authentification requise.' });
      res.locals.user = session.user;
      next();
    }),
  );

  const createLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (_req, res) => userOf(res).oid,
    message: { error: 'Trop de réservations en peu de temps, réessayez plus tard.' },
  });

  router.get('/me', (_req, res) => {
    const user = userOf(res);
    const now = nowLocal(rules.timeZone);
    res.json({
      user: { name: user.name, email: user.email },
      partnerDisplayName: config.PARTNER_DISPLAY_NAME,
      now,
      today: now.slice(0, 10),
      maxDate: addDays(now.slice(0, 10), rules.horizonDays),
      rules: {
        timeZone: rules.timeZone,
        dayStart: rules.dayStart,
        dayEnd: rules.dayEnd,
        slotMinutes: rules.slotMinutes,
        maxDurationMinutes: rules.maxDurationMinutes,
        horizonDays: rules.horizonDays,
        allowWeekends: rules.allowWeekends,
        maxActivePerUser: config.BOOKING_MAX_ACTIVE_PER_USER,
        allowedAttendeeDomains: rules.allowedAttendeeDomains,
      },
    });
  });

  router.get(
    '/rooms',
    wrap(async (_req, res) => {
      res.json(await rooms.listRooms());
    }),
  );

  router.get(
    '/availability',
    wrap(async (req, res) => {
      const date = String(req.query.date ?? '');
      const today = nowLocal(rules.timeZone).slice(0, 10);
      if (!isValidDate(date) || date < today || date > addDays(today, rules.horizonDays)) {
        return res.status(400).json({ error: 'Date invalide.' });
      }
      const [list, busy] = await Promise.all([rooms.listRooms(), rooms.getDayAvailability(date, rules.dayStart, rules.dayEnd)]);
      res.json({ date, rooms: list.map((r) => ({ email: r.email, busy: busy.get(r.email) ?? null })) });
    }),
  );

  router.get(
    '/bookings',
    wrap(async (_req, res) => {
      res.json(await bookings.listUpcoming(userOf(res)));
    }),
  );

  router.post(
    '/bookings',
    createLimiter,
    wrap(async (req, res) => {
      res.status(201).json(await bookings.create(userOf(res), req.body, clientIp(req)));
    }),
  );

  router.delete(
    '/bookings/:id',
    wrap(async (req, res) => {
      await bookings.cancel(userOf(res), String(req.params.id), clientIp(req));
      res.status(204).end();
    }),
  );

  return router;
}
