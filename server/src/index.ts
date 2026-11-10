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
import { createSyncAuthenticator, DirectoryStore, directoryRouter } from './directory.js';
import { GraphClient, GraphError } from './graph.js';
import { clientIp } from './http.js';
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
const directoryTable = table('directory');
if (config.STORAGE_CONNECTION_STRING) {
  // Azurite : en Azure, les tables sont créées par le déploiement Bicep.
  await Promise.all([bookingsTable.createTable(), auditTable.createTable(), directoryTable.createTable()]);
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
const rooms = new RoomService(graph, config.ORGANIZER_UPN, config.TIME_ZONE, config.ROOM_DIRECTORY);
const directoryStore = new DirectoryStore(directoryTable);
// Dernier annuaire transmis par le runbook (prioritaire sur celui relevé au déploiement).
try {
  const saved = await directoryStore.load();
  if (saved.rooms.length) rooms.setDirectory(saved.rooms, saved.syncedAt);
} catch (err) {
  console.warn(JSON.stringify({ type: 'directory_load_failed', message: (err as Error).message }));
}
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

// Défense en profondeur : App Service redirige déjà HTTP vers HTTPS (httpsOnly) ; cette règle couvre un
// accès direct au conteneur. /healthz reste joignable pour la sonde interne.
if (config.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.secure || req.path === '/healthz') return next();
    res.redirect(308, `${config.PUBLIC_BASE_URL}${req.originalUrl}`);
  });
}

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

const here = path.dirname(fileURLToPath(import.meta.url));
// Identifiant du paquet (écrit par build-package.ps1) : permet au déploiement d'attendre la nouvelle version.
const versionFile = path.join(here, '../version.txt');
const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : 'dev';

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', version });
});

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => clientIp(req),
    message: { error: 'Trop de requêtes, réessayez dans un instant.' },
  }),
);
// Avant le parseur JSON global : cette route a sa propre limite de taille et sa propre authentification.
if (config.SYNC_PRINCIPAL_ID) {
  app.use(
    '/api/internal',
    directoryRouter({
      authenticate: createSyncAuthenticator({ tenantId: config.TENANT_ID, clientId: config.ENTRA_CLIENT_ID, syncPrincipalId: config.SYNC_PRINCIPAL_ID }),
      store: directoryStore,
      rooms,
      audit,
    }),
  );
}
app.use(express.json({ limit: '10kb' }));

app.use('/auth', authRouter({ config, msal, sessions, audit }));
app.use('/api', apiRouter({ config, sessions, rooms, bookings, rules }));
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Ressource introuvable.' });
});

const staticDir =[config.STATIC_DIR, path.join(here, '../public'), path.join(here, '../../web/dist')].find(
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
  void bookings.checkOrganizerOnlineMeetings();
});
