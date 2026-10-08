import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser } from './auth.js';
import { ValidationError, HttpError } from './validate.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerInvitationRoutes } from './routes/invitations.js';
import { registerTeamRoutes } from './routes/team.js';
import { registerLeadRoutes } from './routes/leads.js';
import { registerAdminRoutes } from './routes/admin.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true');

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(loadUser);

  // CSRF defence in depth (cookies are also SameSite=Lax): state-changing calls must carry a custom header.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'fetch') {
      return res.status(400).json({ error: 'bad_request' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use(express.static(publicDir, { index: 'index.html', maxAge: '5m' }));

  registerAccountRoutes(app);
  registerInvitationRoutes(app);
  registerTeamRoutes(app);
  registerLeadRoutes(app);
  registerAdminRoutes(app);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) return res.status(422).json({ error: 'validation', fields: err.fields });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, ...err.extra });
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'bad_request' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}
