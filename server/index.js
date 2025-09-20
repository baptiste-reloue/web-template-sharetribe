/**
 * Production server for Sharetribe Web Template (SSR).
 * Renders routes server-side and serves static assets.
 */

require('source-map-support').install();

// Load env (.env.production etc.)
require('./env').configureEnv();

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const enforceSsl = require('express-enforces-ssl');
const passport = require('passport');

const log = require('./log');
const auth = require('./auth');
const apiRouter = require('./apiRouter');
const wellKnownRouter = require('./wellKnownRouter');
const webmanifestResourceRoute = require('./resources/webmanifest');
const robotsTxtRoute = require('./resources/robotsTxt');
const sitemapResourceRoute = require('./resources/sitemap');
const { getExtractors } = require('./importer');
const renderer = require('./renderer');
const dataLoader = require('./dataLoader');
const sdkUtils = require('./api-util/sdk');

// ---------- Config ----------
const buildPath = path.resolve(__dirname, '..', 'build');
const dev = process.env.REACT_APP_ENV === 'development';
const PORT = parseInt(process.env.PORT, 10);
const redirectSSL =
  process.env.SERVER_SHARETRIBE_REDIRECT_SSL != null
    ? process.env.SERVER_SHARETRIBE_REDIRECT_SSL
    : process.env.REACT_APP_SHARETRIBE_USING_SSL;
const REDIRECT_SSL = redirectSSL === 'true';
const TRUST_PROXY = process.env.SERVER_SHARETRIBE_TRUST_PROXY || null;

// Minimal env sanity check (évite un crash silencieux)
const MANDATORY_ENV_VARIABLES = [
  'REACT_APP_SHARETRIBE_SDK_CLIENT_ID',
  'REACT_APP_MARKETPLACE_NAME',
  'REACT_APP_MARKETPLACE_ROOT_URL',
];
const isEmpty = v => v == null || (Object.prototype.hasOwnProperty.call(v, 'length') && v.length === 0);
const missing = MANDATORY_ENV_VARIABLES.filter(k => isEmpty(process.env[k]));
if (missing.length) {
  // Status 9 = “bad env”
  console.error(`Required environment variable is not set: ${missing.join(', ')}`);
  process.exit(9);
}

// ---------- App ----------
const app = express();

const errorPage500 = fs.readFileSync(path.join(buildPath, '500.html'), 'utf-8');
const errorPage404 = fs.readFileSync(path.join(buildPath, '404.html'), 'utf-8');

// Bloque quelques probes courants (php, wp, etc.)
app.use(
  /.*(\.php|\.php7|\/wp-.*\/.*|cgi-bin.*|htdocs\.(rar|zip)|root\.(7z|rar|zip)|www(root)?\.(7z|rar))/,
  (_req, res) => res.status(404).send(errorPage404)
);

// ---------- Security headers (Helmet + CSP Intercom) ----------
// Une SEULE CSP est utilisée ici. Pas de 2ᵉ CSP “nonce” pour éviter l’écrasement.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'", "https:", "data:"],

        // JS Intercom (+ inline nécessaire au boot)
        "script-src": [
          "'self'",
          "'unsafe-inline'",
          "https://widget.intercom.io",
          "https://js.intercomcdn.com",
        ],

        // API & WebSockets Intercom
        "connect-src": [
          "'self'",
          "https://api-iam.intercom.io",
          "https://api-ping.intercom.io",
          "https://nexus-websocket-a.intercom.io",
          "wss://nexus-websocket-a.intercom.io",
          "https://nexus-websocket-b.intercom.io",
          "wss://nexus-websocket-b.intercom.io",
          // ajoute ici d'autres backends si besoin (API Flex custom, etc.)
        ],

        // iFrame du Messenger
        "frame-src": [
          "'self'",
          "https://widget.intercom.io",
        ],

        // Assets (images, fonts) utilisés par le widget
        "img-src": [
          "'self'",
          "data:",
          "https://js.intercomcdn.com",
          "https://static.intercomassets.com",
        ],
        "font-src": [
          "'self'",
          "data:",
          "https://js.intercomcdn.com",
          "https://static.intercomassets.com",
        ],

        // CSS du widget
        "style-src": [
          "'self'",
          "'unsafe-inline'",
          "https://js.intercomcdn.com",
        ],

        // Optionnels utiles selon intégrations
        "worker-src": ["'self'", "blob:"],
        "child-src": ["https://widget.intercom.io"],
      },
    },
    referrerPolicy: { policy: 'origin' },
    // Ces 3 options sont posées à false pour compatibilité large Helmet/SSR
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

// (Option “CSP nonce/report” désactivée—si tu en as besoin, il faudra
// y recopier EXACTEMENT les mêmes domaines que ci-dessus.)

// ---------- HTTPS / proxy ----------
if (REDIRECT_SSL) app.use(enforceSsl());

if (TRUST_PROXY === 'true') app.enable('trust proxy');
else if (TRUST_PROXY === 'false') app.disable('trust proxy');
else if (TRUST_PROXY !== null) app.set('trust proxy', TRUST_PROXY);

// ---------- Middlewares ----------
app.use(compression());
app.use('/static', express.static(path.join(buildPath, 'static')));
app.use(cookieParser());

// favicon
app.get('/favicon.ico', (_req, res) => res.status(404).send('favicon.ico not found.'));

// robots.txt & sitemaps
app.get('/robots.txt', robotsTxtRoute);
app.get('/sitemap-:resource', sitemapResourceRoute);

// PWA manifest
app.get('/site.webmanifest', webmanifestResourceRoute);

// /.well-known (OIDC, Apple, etc.)
app.use('/.well-known', wellKnownRouter);

// Basic auth optionnelle hors dev
if (!dev) {
  const USERNAME = process.env.BASIC_AUTH_USERNAME;
  const PASSWORD = process.env.BASIC_AUTH_PASSWORD;
  if (USERNAME && PASSWORD) app.use(auth.basicAuth(USERNAME, PASSWORD));
}

// Passport
app.use(passport.initialize());

// API côté serveur
app.use('/api', apiRouter);

// Cache-control pour les pages SSR
const noCacheHeaders = {
  'Cache-control': 'no-cache, no-store, must-revalidate',
};

// ---------- SSR route ----------
app.get('*', async (req, res) => {
  // Pas de direct access aux chunks statiques via cette route
  if (req.url.startsWith('/static/')) return res.status(404).send('Static asset not found.');
  if (req.url === '/_status.json') return res.status(200).send({ status: 'ok' });

  const context = {};
  res.set(noCacheHeaders);

  try {
    const { nodeExtractor, webExtractor } = getExtractors();
    const nodeEntrypoint = nodeExtractor.requireEntrypoint();
    const { default: renderApp, ...appInfo } = nodeEntrypoint;

    const sdk = sdkUtils.getSdk(req, res);
    const data = await dataLoader.loadData(req.url, sdk, appInfo);
    const html = await renderer.render(req.url, context, data, renderApp, webExtractor, null);

    if (dev) {
      const debugData = { url: req.url, context };
      // eslint-disable-next-line no-console
      console.log(`\nRender info:\n${JSON.stringify(debugData, null, '  ')}`);
    }

    if (context.unauthorized) {
      const authInfo = await sdk.authInfo();
      if (authInfo && authInfo.isAnonymous === false) {
        return res.status(200).send(html);
      }
      return res.status(401).send(html);
    } else if (context.forbidden) {
      return res.status(403).send(html);
    } else if (context.url) {
      return res.redirect(context.url);
    } else if (context.notfound) {
      return res.status(404).send(html);
    }
    return res.send(html);
  } catch (e) {
    log.error(e, 'server-side-render-failed');
    return res.status(500).send(errorPage500);
  }
});

// Sentry error handler
log.setupExpressErrorHandler(app);

// ---------- Start ----------
const server = app.listen(PORT, () => {
  const mode = dev ? 'development' : 'production';
  // eslint-disable-next-line no-console
  console.log(`Listening to port ${PORT} in ${mode} mode`);
  if (dev) {
    // eslint-disable-next-line no-console
    console.log(`Open http://localhost:${PORT}/ and start hacking!`);
  }
});

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    // eslint-disable-next-line no-console
    console.log('Shutting down...');
    server.close(() => {
      // eslint-disable-next-line no-console
      console.log('Server shut down.');
    });
  });
});
