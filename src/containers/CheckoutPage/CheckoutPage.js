import React, { useEffect, useState } from 'react';
import { compose } from 'redux';
import { connect } from 'react-redux';
import { useHistory, useLocation } from 'react-router-dom';
import { useIntl, FormattedMessage } from 'react-intl';

import { useConfiguration } from '../../context/configurationContext';
import { useRouteConfiguration } from '../../context/routeConfigurationContext';
import { userDisplayNameAsString } from '../../util/data';
import {
  NO_ACCESS_PAGE_INITIATE_TRANSACTIONS,
  NO_ACCESS_PAGE_USER_PENDING_APPROVAL,
  createSlug,
} from '../../util/urlHelpers';
import { hasPermissionToInitiateTransactions, isUserAuthorized } from '../../util/userHelpers';
import { isErrorNoPermissionForInitiateTransactions } from '../../util/errors';
import { resolveLatestProcessName } from '../../transactions/transaction';
import { requireListingImage } from '../../util/configHelpers';

import { isScrollingDisabled } from '../../ducks/ui.duck';
import { confirmCardPayment, retrievePaymentIntent } from '../../ducks/stripe.duck';
import { savePaymentMethod } from '../../ducks/paymentMethods.duck';

import { NamedLink, NamedRedirect, Page } from '../../components';
import { pathByRouteName } from '../../util/routes';

import { storeData, clearData, handlePageData } from './CheckoutPageSessionHelpers';

import {
  initiateOrder,
  initiateCashOrder,
  setInitialValues,
  confirmPayment,
  sendMessage,
} from './CheckoutPage.duck';

import CustomTopbar from './CustomTopbar';
import CheckoutPageWithPayment from './CheckoutPageWithPayment';

import css from './CheckoutPage.module.css';

const STORAGE_KEY = 'CheckoutPage';
const DEFAULT_PROCESS_KEY = 'default-booking';
const onSubmitCallback = () => clearData(STORAGE_KEY);

const getSearchParams = location => new URLSearchParams(location.search || '');
const setSearchParam = (history, location, key, value) => {
  const sp = getSearchParams(location);
  if (value == null) sp.delete(key);
  else sp.set(key, value);
  history.replace({ ...location, search: sp.toString() });
};

// Ne renvoie jamais null/undefined
const getProcessName = pageData => {
  const { transaction, listing, orderData } = pageData || {};

  const txProc = transaction?.attributes?.processName;
  if (txProc) return resolveLatestProcessName(txProc);

  if (orderData?.paymentMethod === 'cash') {
    return resolveLatestProcessName('reloue-booking-cash');
  }

  const alias = listing?.attributes?.publicData?.transactionProcessAlias || null;
  const key = alias ? alias.split('/')[0] : DEFAULT_PROCESS_KEY;
  return resolveLatestProcessName(key);
};

// Écran choix paiement (2 boutons + retour en bas)
const PaymentMethodButtons = ({ pageData, setPageData, history, location, routeConfiguration }) => {
  const listing = pageData?.listing;
  const listingId = listing?.id?.uuid;
  const slug = createSlug(listing?.attributes?.title || '');

  const choose = method => {
    // persiste orderData (pour garder dates, etc.)
    const updated = {
      ...pageData,
      orderData: { ...(pageData.orderData || {}), paymentMethod: method },
    };
    setPageData(updated);
    storeData(updated.orderData, updated.listing, updated.transaction, STORAGE_KEY);

    if (method === 'card') {
      // Checkout par défaut (Stripe)
      setSearchParam(history, location, 'method', 'card');
      // on reste sur CheckoutPage: CheckoutPageWithPayment affichera Stripe
    } else {
      // Checkout cash : nouvelle page sans Stripe
      const to = pathByRouteName('CheckoutCashPage', routeConfiguration, {
        id: listingId,
        slug,
      });
      history.push(to);
    }
  };

  return (
    <div className={css.paymentMethodSelection}>
      <h3 className={css.paymentMethodTitle}>
        <FormattedMessage id="CheckoutPage.paymentMethod.title" defaultMessage="Choisissez votre mode de paiement" />
      </h3>

      <div className={css.paymentButtonsRow}>
        <button type="button" className={`button ${css.choiceButton}`} onClick={() => choose('card')}>
          <FormattedMessage id="CheckoutPage.paymentMethod.card" defaultMessage="Payer par carte" />
        </button>
        <button type="button" className={`button ${css.choiceButton}`} onClick={() => choose('cash')}>
          <FormattedMessage id="CheckoutPage.paymentMethod.cash" defaultMessage="Payer en espèces" />
        </button>
      </div>

      <p className={css.fieldInquiryMessage} style={{ marginTop: 12 }}>
        <FormattedMessage
          id="CheckoutPage.paymentMethod.description"
          defaultMessage="Le prix est identique. Si vous choisissez « Espèces », aucune carte ne sera demandée. Les dates seront bloquées après validation du propriétaire."
        />
      </p>

      {listing ? (
        <div className={css.backToListingBottom}>
          <NamedLink
            name="ListingPage"
            params={{ id: listingId, slug }}
            className={css.backButton}
          >
            <FormattedMessage id="CheckoutPage.backToListing" defaultMessage="⟵ Retour à l’annonce" />
          </NamedLink>
        </div>
      ) : null}
    </div>
  );
};

const EnhancedCheckoutPage = props => {
  const [pageData, setPageData] = useState({});
  const [isDataLoaded, setIsDataLoaded] = useState(false);

  const config = useConfiguration();
  const routeConfiguration = useRouteConfiguration();
  const intl = useIntl();
  const history = useHistory();
  const location = useLocation();

  // Charger données (Redux/session) au montage + lire ?method
  useEffect(() => {
    const { orderData, listing, transaction } = props;
    const data = handlePageData({ orderData, listing, transaction }, STORAGE_KEY, history) || {};
    const methodFromUrl = getSearchParams(location).get('method');
    const normalized =
      methodFromUrl === 'card' || methodFromUrl === 'cash' ? methodFromUrl : (data.orderData || {}).paymentMethod;

    const merged = normalized
      ? { ...data, orderData: { ...(data.orderData || {}), paymentMethod: normalized } }
      : data;

    if (normalized) {
      storeData(merged.orderData, merged.listing, merged.transaction, STORAGE_KEY);
    }

    setPageData(merged);
    setIsDataLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { currentUser, params, scrollingDisabled, initiateOrderError } = props;

  const processName = getProcessName(pageData); // jamais null
  const listing = pageData?.listing;
  const paymentMethodChosen = !!pageData?.orderData?.paymentMethod;

  const isOwnListing = currentUser?.id && listing?.author?.id?.uuid === currentUser?.id?.uuid;

  // Redirections minimales
  if (isDataLoaded && isOwnListing) {
    return <NamedRedirect name="ListingPage" params={params} />;
  }
  if (isDataLoaded && !isUserAuthorized(currentUser)) {
    return (
      <NamedRedirect name="NoAccessPage" params={{ missingAccessRight: NO_ACCESS_PAGE_USER_PENDING_APPROVAL }} />
    );
  }
  if (
    isDataLoaded &&
    (!hasPermissionToInitiateTransactions(currentUser) ||
      isErrorNoPermissionForInitiateTransactions(initiateOrderError))
  ) {
    return (
      <NamedRedirect name="NoAccessPage" params={{ missingAccessRight: NO_ACCESS_PAGE_INITIATE_TRANSACTIONS }} />
    );
  }

  const foundListingTypeConfig = config.listing.listingTypes.find(
    conf => conf.listingType === listing?.attributes?.publicData?.listingType
  );
  const showListingImage = requireListingImage(foundListingTypeConfig);

  const listingTitle = listing?.attributes?.title || '';
  const authorDisplayName = userDisplayNameAsString(listing?.author, '');
  const safeProcessKey = processName || DEFAULT_PROCESS_KEY;
  const title = intl.formatMessage({ id: `CheckoutPage.${safeProcessKey}.title` }, { listingTitle, authorDisplayName });

  if (!paymentMethodChosen || getSearchParams(location).get('method') == null) {
    // Écran de CHOIX
    return (
      <Page title={title} scrollingDisabled={scrollingDisabled}>
        <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
        <div className={css.contentContainer}>
          <div className={css.orderFormContainer}>
            <PaymentMethodButtons
              pageData={pageData}
              setPageData={setPageData}
              history={history}
              location={location}
              routeConfiguration={routeConfiguration}
            />
          </div>
        </div>
      </Page>
    );
  }

  // Si ?method=card, on affiche le checkout par défaut avec Stripe (déjà géré)
  return (
    <CheckoutPageWithPayment
      key={pageData?.orderData?.paymentMethod || 'card'}
      config={config}
      routeConfiguration={routeConfiguration}
      intl={intl}
      history={history}
      processName={safeProcessKey}
      sessionStorageKey={STORAGE_KEY}
      pageData={pageData}
      setPageData={setPageData}
      listingTitle={listingTitle}
      title={title}
      onSubmitCallback={onSubmitCallback}
      showListingImage={showListingImage}
      {...props}
    />
  );
};

// ----------------------- Redux wiring -----------------------

const mapStateToProps = state => {
  const { listing, orderData, transaction, initiateOrderError } = state.CheckoutPage;
  const { currentUser } = state.user;
  const { confirmCardPaymentError, paymentIntent, retrievePaymentIntentError } = state.stripe;

  return {
    scrollingDisabled: isScrollingDisabled(state),
    currentUser,
    orderData,
    transaction,
    listing,
    initiateOrderError,
    confirmCardPaymentError,
    paymentIntent,
    retrievePaymentIntentError,
  };
};

const mapDispatchToProps = dispatch => ({
  dispatch,
  onInitiateOrder: (params, alias, txId, transition, isPriv) =>
    dispatch(initiateOrder(params, alias, txId, transition, isPriv)),
  onInitiateCashOrder: (params, txId) => dispatch(initiateCashOrder(params, txId)),
  onRetrievePaymentIntent: params => dispatch(retrievePaymentIntent(params)),
  onConfirmCardPayment: params => dispatch(confirmCardPayment(params)),
  onConfirmPayment: (id, name, p) => dispatch(confirmPayment(id, name, p)),
  onSendMessage: params => dispatch(sendMessage(params)),
  onSavePaymentMethod: (cust, pm) => dispatch(savePaymentMethod(cust, pm)),
});

const CheckoutPage = compose(connect(mapStateToProps, mapDispatchToProps))(EnhancedCheckoutPage);

// Toujours écrire en session pour ne plus perdre les dates
CheckoutPage.setInitialValues = initialValues => {
  const { listing, orderData, transaction = null } = initialValues || {};
  storeData(orderData || {}, listing || null, transaction, STORAGE_KEY);
  return setInitialValues(initialValues);
};

CheckoutPage.displayName = 'CheckoutPage';
export default CheckoutPage;
