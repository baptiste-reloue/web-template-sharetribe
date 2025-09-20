/**
 * Production server for Sharetribe Web Template (SSR).
 * Renders routes server-side and serves static assets.
 */

require('source-map-support').install();
require('./env').configureEnv();

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
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

const buildPath = path.resolve(__dirname, '..', 'build');
const dev = process.env.REACT_APP_ENV === 'development';
const PORT = parseInt(process.env.PORT, 10);
const redirectSSL =
  process.env.SERVER_SHARETRIBE_REDIRECT_SSL != null
    ? process.env.SERVER_SHARETRIBE_REDIRECT_SSL
    : process.env.REACT_APP_SHARETRIBE_USING_SSL;
const REDIRECT_SSL = redirectSSL === 'true';
const TRUST_PROXY = process.env.SERVER_SHARETRIBE_TRUST_PROXY || null;

const app = express();

const errorPage500 = fs.readFileSync(path.join(buildPath, '500.html'), 'utf-8');
const errorPage404 = fs.readFileSync(path.join(buildPath, '404.html'), 'utf-8');

// filtre quelques probes
app.use(/.*(\.php|\/wp-.*\/.*|cgi-bin.*|htdocs\.(rar|zip)|root\.(7z|rar|zip)|www(root)?\.(7z|rar))$/, (_req, res) => {
  res.status(404).send(errorPage404);
});

// ---- Security headers (UNE seule CSP, compatible Intercom & CDNs) ----
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'", "https:", "data:"],

      // scripts Intercom
      "script-src": [
        "'self'",
        "'unsafe-inline'",
        "https://widget.intercom.io",
        "https://js.intercomcdn.com",
      ],

      // APIs, hosted-configs, websockets, Stripe, Mapbox, etc.
      "connect-src": [
        "'self'",
        "https:",
        "wss:",
        "https://api-iam.intercom.io",
        "https://api-ping.intercom.io",
        "https://nexus-websocket-a.intercom.io",
        "wss://nexus-websocket-a.intercom.io",
        "https://nexus-websocket-b.intercom.io",
        "wss://nexus-websocket-b.intercom.io",
      ],

      // iFrame du messenger
      "frame-src": ["'self'", "https://widget.intercom.io"],

      // images & fonts depuis n’importe quel CDN https + data:
      "img-src": ["'self'", "https:", "data:"],
      "font-src": ["'self'", "https:", "data:"],

      // CSS (incl. inline + CDNs)
      "style-src": ["'self'", "'unsafe-inline'", "https:"],

      "worker-src": ["'self'", "blob:"],
    },
  },
  referrerPolicy: { policy: 'origin' },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));

if (REDIRECT_SSL) app.use(enforceSsl());

// trust proxy
if (TRUST_PROXY === 'true') app.enable('trust proxy');
else if (TRUST_PROXY === 'false') app.disable('trust proxy');
else if (TRUST_PROXY !== null) app.set('trust proxy', TRUST_PROXY);

app.use(compression());
app.use('/static', express.static(path.join(buildPath, 'static')));
app.use(cookieParser());

// favicon
app.get('/favicon.ico', (_req, res) => res.status(404).send('favicon.ico not found.'));

// robots / sitemap / manifest / well-known
app.get('/robots.txt', robotsTxtRoute);
app.get('/sitemap-:resource', sitemapResourceRoute);
app.get('/site.webmanifest', webmanifestResourceRoute);
app.use('/.well-known', wellKnownRouter);

// basic auth optionnelle
if (!dev) {
  const { BASIC_AUTH_USERNAME: U, BASIC_AUTH_PASSWORD: P } = process.env;
  if (U && P) app.use(auth.basicAuth(U, P));
}

// passport
app.use(passport.initialize());

// API server-side
app.use('/api', apiRouter);

const noCacheHeaders = { 'Cache-control': 'no-cache, no-store, must-revalidate' };

// SSR
app.get('*', async (req, res) => {
  if (req.url.startsWith('/static/')) return res.status(404).send('Static asset not found.');
  if (req.url === '/_status.json') return res.status(200).send({ status: 'ok' });

  const context = {};
  res.set(noCacheHeaders);

  try {
    const { nodeExtractor, webExtractor } = getExtractors();
    const { default: renderApp, ...appInfo } = nodeExtractor.requireEntrypoint();

    const sdk = sdkUtils.getSdk(req, res);
    const data = await dataLoader.loadData(req.url, sdk, appInfo);
    const html = await renderer.render(req.url, context, data, renderApp, webExtractor, null);

    if (dev) console.log(`\nRender info:\n${JSON.stringify({ url: req.url, context }, null, 2)}`);

    if (context.unauthorized) {
      const authInfo = await sdk.authInfo();
      return res.status(authInfo && authInfo.isAnonymous === false ? 200 : 401).send(html);
    } else if (context.forbidden) return res.status(403).send(html);
    else if (context.url) return res.redirect(context.url);
    else if (context.notfound) return res.status(404).send(html);
    else return res.send(html);
  } catch (e) {
    log.error(e, 'server-side-render-failed');
    return res.status(500).send(errorPage500);
  }
});

// Sentry
log.setupExpressErrorHandler(app);

// start
const server = app.listen(PORT, () => {
  const mode = dev ? 'development' : 'production';
  console.log(`Listening to port ${PORT} in ${mode} mode`);
  if (dev) console.log(`Open http://localhost:${PORT}/ and start hacking!`);
});

['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    console.log('Shutting down...');
    server.close(() => console.log('Server shut down.'));
  });
});
