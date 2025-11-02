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

import { storeData, clearData, handlePageData } from './CheckoutPageSessionHelpers';
import {
  initiateOrder,
  initiateCashOrder,
  setInitialValues as setInitialValuesDuck,
  confirmPayment,
  sendMessage,
} from './CheckoutPage.duck';

import CustomTopbar from './CustomTopbar';
import CheckoutPageWithPayment from './CheckoutPageWithPayment';

import css from './CheckoutPage.module.css';

const STORAGE_KEY = 'CheckoutPage';
const DEFAULT_PROCESS_KEY = 'default-booking';
const CASH_PROCESS_KEY = 'reloue-booking-cash';
const onSubmitCallback = () => clearData(STORAGE_KEY);

// Helpers
const getSearchParams = location => new URLSearchParams(location?.search || '');

const computeProcessName = (pageData, forceCard) => {
  const { transaction, listing, orderData } = pageData || {};

  // Transaction déjà créée
  const txProc = transaction?.attributes?.processName;
  if (txProc) return resolveLatestProcessName(txProc);

  // Si on force carte via URL -> toujours default-booking
  if (forceCard) return resolveLatestProcessName(DEFAULT_PROCESS_KEY);

  // Si choix cash en mémoire -> process cash
  if (orderData?.paymentMethod === 'cash') return resolveLatestProcessName(CASH_PROCESS_KEY);

  // Sinon alias éventuel de l’annonce, à défaut default-booking
  const alias = listing?.attributes?.publicData?.transactionProcessAlias || null;
  const key = alias ? alias.split('/')[0] : DEFAULT_PROCESS_KEY;
  return resolveLatestProcessName(key);
};

// ------------------- Bloc CHOIX du mode de paiement -------------------
const PaymentMethodButtons = ({ pageData, setPageData, history, location, routeParams }) => {
  const listing = pageData?.listing;
  const listingId = listing?.id?.uuid || routeParams?.id || '';
  const slug =
    createSlug(listing?.attributes?.title || '') ||
    routeParams?.slug ||
    'annonce';

  const choose = method => {
    // Persiste dates/qty + choix
    const updated = {
      ...pageData,
      orderData: { ...(pageData.orderData || {}), paymentMethod: method },
    };
    setPageData(updated);
    storeData(updated.orderData, updated.listing, updated.transaction, STORAGE_KEY);

    if (method === 'card') {
      const url = listingId && slug
        ? `/l/${slug}/${listingId}/checkout?method=card`
        : `${location.pathname}?method=card`;
      history.replace(url);
      if (typeof window !== 'undefined') window.scrollTo(0, 0);
    } else {
      if (listingId && slug) history.push(`/l/${slug}/${listingId}/checkout-cash`);
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
            params={{ id: listing?.id?.uuid, slug: createSlug(listing?.attributes?.title || '') }}
            className={css.backButton}
          >
            <FormattedMessage id="CheckoutPage.backToListing" defaultMessage="⟵ Retour à l’annonce" />
          </NamedLink>
        </div>
      ) : null}
    </div>
  );
};

// --------------------------------- Page ---------------------------------
const EnhancedCheckoutPage = props => {
  const [pageData, setPageData] = useState({});
  const [isDataLoaded, setIsDataLoaded] = useState(false);

  const config = useConfiguration();
  const routeConfiguration = useRouteConfiguration();
  const intl = useIntl();
  const history = useHistory();
  const location = useLocation();

  // Lecture de l'intention depuis l'URL (force carte)
  const methodFromUrl = getSearchParams(location).get('method');
  const forceCard = methodFromUrl === 'card';

  // Charger données (Redux/session) au montage + normaliser le choix
  useEffect(() => {
    const { orderData, listing, transaction } = props;
    const data = handlePageData({ orderData, listing, transaction }, STORAGE_KEY, history) || {};

    // Si l'URL force carte, on écrase tout choix précédent
    const normalized =
      forceCard ? 'card'
      : (data.orderData || {}).paymentMethod || null;

    const merged = normalized
      ? { ...data, orderData: { ...(data.orderData || {}), paymentMethod: normalized } }
      : data;

    if (normalized) {
      storeData(merged.orderData, merged.listing, merged.transaction, STORAGE_KEY);
    }

    setPageData(merged);
    setIsDataLoaded(true);
  }, []); // une seule fois

  const {
    currentUser,
    params, // { slug, id } depuis la route
    scrollingDisabled,
    initiateOrderError,
  } = props;

  const listing = pageData?.listing;
  const processName = computeProcessName(pageData, forceCard); // ici on force bien default-booking si ?method=card

  // Garde-fous d’accès
  const isOwnListing =
    currentUser?.id && listing?.author?.id?.uuid && listing.author.id.uuid === currentUser.id.uuid;

  if (isDataLoaded && isOwnListing) {
    return <NamedRedirect name="ListingPage" params={params} />;
  }
  if (isDataLoaded && !isUserAuthorized(currentUser)) {
    return (
      <NamedRedirect
        name="NoAccessPage"
        params={{ missingAccessRight: NO_ACCESS_PAGE_USER_PENDING_APPROVAL }}
      />
    );
  }
  if (
    isDataLoaded &&
    (!hasPermissionToInitiateTransactions(currentUser) ||
      isErrorNoPermissionForInitiateTransactions(initiateOrderError))
  ) {
    return (
      <NamedRedirect
        name="NoAccessPage"
        params={{ missingAccessRight: NO_ACCESS_PAGE_INITIATE_TRANSACTIONS }}
      />
    );
  }

  // Contexte d'affichage
  const listingTitle = listing?.attributes?.title || '';
  const authorDisplayName = userDisplayNameAsString(listing?.author, '');
  const safeProcessKey = processName || DEFAULT_PROCESS_KEY;

  const title = intl.formatMessage(
    { id: `CheckoutPage.${safeProcessKey}.title` },
    { listingTitle, authorDisplayName }
  );

  const foundListingTypeConfig = config.listing.listingTypes.find(
    conf => conf.listingType === listing?.attributes?.publicData?.listingType
  );
  const showListingImage = requireListingImage(foundListingTypeConfig);

  // Afficher Stripe si : ?method=card OU choix 'card' en mémoire
  const showStripe = forceCard || pageData?.orderData?.paymentMethod === 'card';

  if (!showStripe) {
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
              routeParams={params}
            />
          </div>
        </div>
      </Page>
    );
  }

  // Checkout CARTE (Stripe)
  return (
    <CheckoutPageWithPayment
      key={pageData?.orderData?.paymentMethod || 'card'}
      config={config}
      routeConfiguration={routeConfiguration}
      intl={intl}
      history={history}
      processName={safeProcessKey}           // => "default-booking" si ?method=card
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

// Conserver les infos en session après pageDataLoadingAPI
CheckoutPage.setInitialValues = initialValues => {
  const { listing, orderData, transaction = null } = initialValues || {};
  storeData(orderData || {}, listing || null, transaction, STORAGE_KEY);
  return setInitialValuesDuck(initialValues);
};

CheckoutPage.displayName = 'CheckoutPage';
export default CheckoutPage;
