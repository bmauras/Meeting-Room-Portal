import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { TableClient } from '@azure/data-tables';
import { DefaultAzureCredential, ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import { AuditLog } from './audit.js';
import { BookingError, BookingService } from './bookings.js';
import { loadConfig } from './config.js';
import { GraphClient, GraphError } from './graph.js';
import { RoomService } from './rooms.js';
import type { BookingRules } from './rules.js';
import { apiRouter } from './routes/api.js';
import { authRouter, createMsalClient } from './routes/auth.js';
import { createSessions } from './session.js';
import { BookingStore } from './store.js';

const config = loadConfig();

// En Azure : uniquement la Managed Identity. En local : DefaultAzureCredential (variables AZURE_*, az login…).
const credential: TokenCredential =
  config.NODE_ENV === 'production' ? new ManagedIdentityCredential({ clientId: config.AZURE_CLIENT_ID! }) : new DefaultAzureCredential();

function table(name: string): TableClient {
  return config.STORAGE_CONNECTION_STRING
    ? TableClient.fromConnectionString(config.STORAGE_CONNECTION_STRING, name, { allowInsecureConnection: true })
    : new TableClient(config.STORAGE_TABLE_ENDPOINT, name, credential);
}

const bookingsTable = table('bookings');
const auditTable = table('audit');
if (config.STORAGE_CONNECTION_STRING) {
  // Azurite : en Azure, les tables sont créées par le déploiement Bicep.
  await Promise.all([bookingsTable.createTable(), auditTable.createTable()]);
}

const rules: BookingRules = {
  timeZone: config.TIME_ZONE,
  dayStart: config.BOOKING_DAY_START,
  dayEnd: config.BOOKING_DAY_END,
  slotMinutes: config.BOOKING_SLOT_MINUTES,
  maxDurationMinutes: config.BOOKING_MAX_DURATION_MINUTES,
  horizonDays: config.BOOKING_HORIZON_DAYS,
  allowWeekends: config.BOOKING_ALLOW_WEEKENDS,
  allowedAttendeeDomains: config.ALLOWED_ATTENDEE_DOMAINS,
};

const graph = new GraphClient(credential, config.TIME_ZONE);
const rooms = new RoomService(graph, config.ORGANIZER_UPN, config.TIME_ZONE);
const audit = new AuditLog(auditTable);
const bookings = new BookingService({
  graph,
  rooms,
  store: new BookingStore(bookingsTable),
  audit,
  rules,
  organizer: config.ORGANIZER_UPN,
  partnerDisplayName: config.PARTNER_DISPLAY_NAME,
  publicBaseUrl: config.PUBLIC_BASE_URL,
  maxActivePerUser: config.BOOKING_MAX_ACTIVE_PER_USER,
});
const sessions = createSessions(config.SESSION_SECRET, config.PUBLIC_BASE_URL.startsWith('https://'));
const msal = createMsalClient(config);

const app = express();
app.disable('x-powered-by');
// Derrière le frontal App Service : req.ip est l'IP cliente réelle.
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' },
  }),
);

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Trop de requêtes, réessayez dans un instant.' },
  }),
);
app.use(express.json({ limit: '10kb' }));

app.use('/auth', authRouter({ config, msal, sessions, audit }));
app.use('/api', apiRouter({ config, sessions, rooms, bookings, rules }));
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Ressource introuvable.' });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = [config.STATIC_DIR, path.join(here, '../public'), path.join(here, '../../web/dist')].find(
  (dir): dir is string => Boolean(dir) && fs.existsSync(path.join(dir!, 'index.html')),
);
if (staticDir) {
  app.use('/assets', express.static(path.join(staticDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
  app.use(express.static(staticDir, { index: false, maxAge: 0 }));
  app.get('*', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof BookingError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof GraphError) {
    console.error(JSON.stringify({ type: 'graph_error', status: err.status, code: err.code, message: err.message, path: req.path }));
    res.status(502).json({ error: 'Le service de calendrier est momentanément indisponible. Réessayez.' });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed' || (err as { type?: string }).type === 'entity.too.large') {
    res.status(400).json({ error: 'Requête invalide.' });
    return;
  }
  console.error(JSON.stringify({ type: 'unhandled_error', message: (err as Error).message, stack: (err as Error).stack, path: req.path }));
  res.status(500).json({ error: 'Erreur interne.' });
};
app.use(errorHandler);

app.listen(config.PORT, () => {
  console.log(`Meeting Room Portal à l'écoute sur le port ${config.PORT}`);
});
