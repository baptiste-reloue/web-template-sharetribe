import React from 'react';
import { any, string } from 'prop-types';
import { HelmetProvider } from 'react-helmet-async';
import { BrowserRouter, StaticRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import loadable from '@loadable/component';
import difference from 'lodash/difference';
import mapValues from 'lodash/mapValues';
import moment from 'moment';

import defaultConfig from './config/configDefault';
import appSettings from './config/settings';
import configureStore from './store';

import { RouteConfigurationProvider } from './context/routeConfigurationContext';
import { ConfigurationProvider } from './context/configurationContext';
import { mergeConfig } from './util/configHelpers';
import { IntlProvider } from './util/reactIntl';
import { includeCSSProperties } from './util/style';
import { IncludeScripts } from './util/includeScripts';

import { MaintenanceMode } from './components';
import routeConfiguration from './routing/routeConfiguration';
import Routes from './routing/Routes';
import defaultMessages from './translations/en.json';

// Intercom (client-only)
import IntercomMessenger from './components/IntercomMessenger';

const messagesInLocale = {};
const isTestEnv = process.env.NODE_ENV === 'test';
const addMissingTranslations = (src, tgt) => {
  const srcKeys = Object.keys(src);
  const tgtKeys = Object.keys(tgt);
  if (tgtKeys.length === 0) return src;
  const missingKeys = difference(srcKeys, tgtKeys);
  return missingKeys.reduce((acc, k) => ({ ...acc, [k]: src[k] }), tgt);
};
const localeMessages = isTestEnv
  ? mapValues(defaultMessages, (_val, key) => key)
  : addMissingTranslations(defaultMessages, messagesInLocale);

const MomentLocaleLoader = props => {
  const { children, locale } = props;
  const isAlreadyImportedLocale =
    typeof hardCodedLocale !== 'undefined' && locale === hardCodedLocale;
  const NoLoader = p => <>{p.children()}</>;
  const MomentLocale =
    ['en', 'en-US'].includes(locale) || isAlreadyImportedLocale
      ? NoLoader
      : ['fr', 'fr-FR'].includes(locale)
      ? loadable.lib(() => import(/* webpackChunkName: "fr" */ 'moment/locale/fr'))
      : ['de', 'de-DE'].includes(locale)
      ? loadable.lib(() => import(/* webpackChunkName: "de" */ 'moment/locale/de'))
      : ['es', 'es-ES'].includes(locale)
      ? loadable.lib(() => import(/* webpackChunkName: "es" */ 'moment/locale/es'))
      : ['fi', 'fi-FI'].includes(locale)
      ? loadable.lib(() => import(/* webpackChunkName: "fi" */ 'moment/locale/fi'))
      : ['nl', 'nl-NL'].includes(locale)
      ? loadable.lib(() => import(/* webpackChunkName: "nl" */ 'moment/locale/nl'))
      : loadable.lib(() => import(/* webpackChunkName: "locales" */ 'moment/min/locales.min'));

  return (
    <MomentLocale>
      {() => {
        moment.locale(locale);
        return children;
      }}
    </MomentLocale>
  );
};

const Configurations = props => {
  const { appConfig, children } = props;
  const routeConfig = routeConfiguration(appConfig.layout, appConfig?.accessControl);
  const locale = isTestEnv ? 'en' : appConfig.localization.locale;

  return (
    <ConfigurationProvider value={appConfig}>
      <MomentLocaleLoader locale={locale}>
        <RouteConfigurationProvider value={routeConfig}>{children}</RouteConfigurationProvider>
      </MomentLocaleLoader>
    </ConfigurationProvider>
  );
};

const MaintenanceModeError = props => {
  const { locale, messages, helmetContext } = props;
  return (
    <IntlProvider locale={locale} messages={messages} textComponent="span">
      <HelmetProvider context={helmetContext}>
        <MaintenanceMode />
      </HelmetProvider>
    </IntlProvider>
  );
};

export const ClientApp = props => {
  const { store, hostedTranslations = {}, hostedConfig = {} } = props;
  const appConfig = mergeConfig(hostedConfig, defaultConfig);

  if (!appConfig.hasMandatoryConfigurations) {
    return (
      <MaintenanceModeError
        locale={appConfig.localization.locale}
        messages={{ ...localeMessages, ...hostedTranslations }}
      />
    );
  }

  // couleurs/branding (nécessite que la CSP autorise "style-src https:")
  includeCSSProperties(appConfig.branding, window.document.documentElement);

  const logLoadDataCalls = appSettings?.env !== 'test';

  // currentUser depuis le store (côté client)
  const cu = store.getState().user?.currentUser;
  const intercomUser = cu
    ? {
        id: cu.id?.uuid,
        email: cu.attributes?.email,
        name: cu.attributes?.profile?.displayName || 'Utilisateur',
        createdAt: cu.attributes?.createdAt,
        user_hash: cu.attributes?.protectedData?.intercomUserHash,
      }
    : null;

  return (
    <Configurations appConfig={appConfig}>
      <IntlProvider
        locale={appConfig.localization.locale}
        messages={{ ...localeMessages, ...hostedTranslations }}
        textComponent="span"
      >
        <Provider store={store}>
          <HelmetProvider>
            <IncludeScripts config={appConfig} />
            <BrowserRouter>
              <Routes logLoadDataCalls={logLoadDataCalls} />
            </BrowserRouter>
            {/* Intercom visible partout */}
            <IntercomMessenger user={intercomUser} />
          </HelmetProvider>
        </Provider>
      </IntlProvider>
    </Configurations>
  );
};
ClientApp.propTypes = { store: any.isRequired };

export const ServerApp = props => {
  const { url, context, helmetContext, store, hostedTranslations = {}, hostedConfig = {} } = props;
  const appConfig = mergeConfig(hostedConfig, defaultConfig);
  HelmetProvider.canUseDOM = false;

  if (!appConfig.hasMandatoryConfigurations) {
    return (
      <MaintenanceModeError
        locale={appConfig.localization.locale}
        messages={{ ...localeMessages, ...hostedTranslations }}
        helmetContext={helmetContext}
      />
    );
  }

  return (
    <Configurations appConfig={appConfig}>
      <IntlProvider
        locale={appConfig.localization.locale}
        messages={{ ...localeMessages, ...hostedTranslations }}
        textComponent="span"
      >
        <Provider store={store}>
          <HelmetProvider context={helmetContext}>
            <IncludeScripts config={appConfig} />
            <StaticRouter location={url} context={context}>
              <Routes />
            </StaticRouter>
          </HelmetProvider>
        </Provider>
      </IntlProvider>
    </Configurations>
  );
};
ServerApp.propTypes = { url: string.isRequired, context: any.isRequired, store: any.isRequired };

export const renderApp = (url, serverContext, preloadedState, hostedTranslations, hostedConfig, collectChunks) => {
  const store = configureStore(preloadedState);
  const helmetContext = {};
  const WithChunks = collectChunks(
    <ServerApp
      url={url}
      context={serverContext}
      helmetContext={helmetContext}
      store={store}
      hostedTranslations={hostedTranslations}
      hostedConfig={hostedConfig}
    />
  );
  return import('react-dom/server').then(mod => {
    const { default: ReactDOMServer } = mod;
    const body = ReactDOMServer.renderToString(WithChunks);
    const { helmet: head } = helmetContext;
    return { head, body };
  });
};
