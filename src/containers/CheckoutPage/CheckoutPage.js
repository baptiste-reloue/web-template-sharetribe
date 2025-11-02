import React, { useEffect, useState, useMemo } from 'react';
import { compose } from 'redux';
import { connect } from 'react-redux';
import { useHistory, useLocation } from 'react-router-dom';
import { useIntl } from 'react-intl';

// Contexts & utils
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
import { INQUIRY_PROCESS_NAME, resolveLatestProcessName } from '../../transactions/transaction';
import { requireListingImage } from '../../util/configHelpers';

// Ducks
import { isScrollingDisabled } from '../../ducks/ui.duck';
import { confirmCardPayment, retrievePaymentIntent } from '../../ducks/stripe.duck';
import { savePaymentMethod } from '../../ducks/paymentMethods.duck';

// Components
import { NamedRedirect, Page, H3, Button, NamedLink } from '../../components';

// Session helpers (doivent être importés avant les sous-pages)
import { storeData, clearData, handlePageData } from './CheckoutPageSessionHelpers';

// Ducks locaux
import {
  initiateOrder,
  setInitialValues,
  speculateTransaction,
  stripeCustomer,
  confirmPayment,
  sendMessage,
  initiateInquiryWithoutPayment,
} from './CheckoutPage.duck';

import CustomTopbar from './CustomTopbar';
import CheckoutPageWithPayment, {
  loadInitialDataForStripePayments,
} from './CheckoutPageWithPayment';
import CheckoutPageWithInquiryProcess from './CheckoutPageWithInquiryProcess';

// Styles
import css from './CheckoutPage.module.css';

const STORAGE_KEY = 'CheckoutPage';

const onSubmitCallback = () => {
  clearData(STORAGE_KEY);
};

// Récupère le nom de process à partir des données (sans tenir compte du choix UI)
const baseProcessName = pageData => {
  const { transaction, listing } = pageData || {};
  const processName = transaction?.id
    ? transaction?.attributes?.processName
    : listing?.id
    ? listing?.attributes?.publicData?.transactionProcessAlias?.split('/')[0]
    : null;
  return resolveLatestProcessName(processName);
};

// Lecture simple du paramètre ?method=card|cash
const usePaymentMethodParam = () => {
  const { search } = useLocation();
  return useMemo(() => {
    const params = new URLSearchParams(search);
    const method = params.get('method');
    return method === 'card' || method === 'cash' ? method : null;
  }, [search]);
};

const EnhancedCheckoutPage = props => {
  const [pageData, setPageData] = useState({});
  const [isDataLoaded, setIsDataLoaded] = useState(false);

  const config = useConfiguration();
  const routeConfiguration = useRouteConfiguration();
  const intl = useIntl();
  const history = useHistory();
  const location = useLocation();
  const chosenMethod = usePaymentMethodParam(); // null | 'card' | 'cash'

  useEffect(() => {
    const {
      currentUser,
      orderData,
      listing,
      transaction,
      fetchSpeculatedTransaction,
      fetchStripeCustomer,
    } = props;

    const initialData = { orderData, listing, transaction };
    const data = handlePageData(initialData, STORAGE_KEY, history);
    setPageData(data || {});
    setIsDataLoaded(true);

    // Si l'utilisateur est autorisé, précharge Stripe uniquement pour le mode carte
    if (isUserAuthorized(currentUser) && (chosenMethod === 'card' || chosenMethod === null)) {
      // Chargement Stripe uniquement si le process n’est pas un process “inquiry”
      if (baseProcessName(data) !== INQUIRY_PROCESS_NAME) {
        loadInitialDataForStripePayments({
          pageData: data || {},
          fetchSpeculatedTransaction,
          fetchStripeCustomer,
          config,
        });
      }
    }
  }, []); // initial mount only

  const {
    currentUser,
    params,
    scrollingDisabled,
    speculateTransactionInProgress,
    onInquiryWithoutPayment,
    initiateOrderError,
  } = props;

  // Si l’annonce appartient au user ou si data manquante/incorrecte -> retour Listing
  const listing = pageData?.listing;
  const isOwnListing = currentUser?.id && listing?.author?.id?.uuid === currentUser?.id?.uuid;

  // process de base indiqué sur l’annonce (ex: default-booking)
  const discoveredProcess = baseProcessName(pageData);

  // Process utilisé selon le choix utilisateur :
  // - carte -> "default-booking"
  // - espèces -> "reloue-booking-cash"
  const processName = chosenMethod === 'cash'
    ? 'reloue-booking-cash'
    : discoveredProcess || 'default-booking';

  const isInquiryProcess = processName === INQUIRY_PROCESS_NAME;

  const hasRequiredData = !!(listing?.id && listing?.author?.id && processName);
  const shouldRedirect = isDataLoaded && !(hasRequiredData && !isOwnListing);
  const shouldRedirectUnathorizedUser = isDataLoaded && !isUserAuthorized(currentUser);
  const shouldRedirectNoTransactionRightsUser =
    isDataLoaded &&
    (!hasPermissionToInitiateTransactions(currentUser) ||
      isErrorNoPermissionForInitiateTransactions(initiateOrderError));

  if (shouldRedirect) {
    // eslint-disable-next-line no-console
    console.error('Missing or invalid data for checkout, redirecting back to listing page.', {
      listing,
    });
    return <NamedRedirect name="ListingPage" params={params} />;
  } else if (shouldRedirectUnathorizedUser) {
    return (
      <NamedRedirect
        name="NoAccessPage"
        params={{ missingAccessRight: NO_ACCESS_PAGE_USER_PENDING_APPROVAL }}
      />
    );
  } else if (shouldRedirectNoTransactionRightsUser) {
    return (
      <NamedRedirect
        name="NoAccessPage"
        params={{ missingAccessRight: NO_ACCESS_PAGE_INITIATE_TRANSACTIONS }}
      />
    );
  }

  // Visuel titre & image
  const validListingTypes = config.listing.listingTypes;
  const foundListingTypeConfig = validListingTypes.find(
    conf => conf.listingType === listing?.attributes?.publicData?.listingType
  );
  const showListingImage = requireListingImage(foundListingTypeConfig);

  const listingTitle = listing?.attributes?.title;
  const authorDisplayName = userDisplayNameAsString(listing?.author, '');
  const title = processName
    ? intl.formatMessage(
        { id: `CheckoutPage.${processName}.title` },
        { listingTitle, authorDisplayName }
      )
    : 'Checkout page is loading data';

  // ---------- ÉCRAN DE CHOIX (si aucun ?method=...) ----------
  if (!chosenMethod) {
    const goBackToListing = () => {
      if (listing?.id) {
        history.push(
          `/l/${createSlug(listingTitle)}/${listing.id.uuid}`
        );
      } else {
        history.goBack();
      }
    };

// ...dans CheckoutPage.js, à l'intérieur du bloc if (!chosenMethod) { ... }

  const chooseCard = () => {
    const updated = {
      ...pageData,
      orderData: { ...(pageData.orderData || {}), paymentMethod: 'card' },
    };
    setPageData(updated);
    // ⚠️ on persiste pour la page Stripe
    storeData(updated.orderData, updated.listing, updated.transaction, STORAGE_KEY);

    const url = new URL(window.location.href);
    url.searchParams.set('method', 'card');
    history.push(`${location.pathname}?${url.searchParams.toString()}`);
  };

  const chooseCash = () => {
    if (!listing?.id) return;

    const updated = {
      ...pageData,
      orderData: { ...(pageData.orderData || {}), paymentMethod: 'cash' },
    };
    setPageData(updated);
    // ⚠️ on persiste pour CheckoutCashPage
    storeData(updated.orderData, updated.listing, updated.transaction, STORAGE_KEY);

    history.push(`/l/${createSlug(listingTitle)}/${listing.id.uuid}/checkout-cash`);
  };

    return (
      <Page title={title} scrollingDisabled={scrollingDisabled}>
        <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
        <div className={css.choiceContainer}>
          <div className={css.choiceHeaderRow}>
            <button type="button" className={css.backLinkButton} onClick={goBackToListing}>
              ← <span>{intl.formatMessage({ id: 'CheckoutPage.backToListing' })}</span>
            </button>
          </div>

          <div className={css.choiceCard}>
            <H3 as="h1" className={css.choiceTitle}>
              {intl.formatMessage({ id: 'CheckoutPage.choosePayment.title' })}
            </H3>

            <div className={css.choiceButtonsRow}>
              <Button className={css.choiceBtn} onClick={chooseCard}>
                {intl.formatMessage({ id: 'CheckoutPage.choosePayment.payByCard' })}
              </Button>

              <Button className={css.choiceBtn} onClick={chooseCash} type="button">
                {intl.formatMessage({ id: 'CheckoutPage.choosePayment.payInCash' })}
              </Button>
            </div>

            <p className={css.choiceNote}>
              {intl.formatMessage({ id: 'CheckoutPage.choosePayment.note' })}
            </p>

            <div className={css.choiceFooter}>
              <button type="button" className={css.backWideBtn} onClick={goBackToListing}>
                ← {intl.formatMessage({ id: 'CheckoutPage.backToListing' })}
              </button>
            </div>
          </div>
        </div>
      </Page>
    );
  }
  // ---------- /ÉCRAN DE CHOIX ----------

  // Si process d’enquiry : on bascule vers la page inquiry (cas standard Sharetribe)
  if (processName && isInquiryProcess) {
    return (
      <CheckoutPageWithInquiryProcess
        config={config}
        routeConfiguration={routeConfiguration}
        intl={intl}
        history={history}
        processName={processName}
        pageData={pageData}
        listingTitle={listingTitle}
        title={title}
        onInquiryWithoutPayment={onInquiryWithoutPayment}
        onSubmitCallback={onSubmitCallback}
        showListingImage={showListingImage}
        {...props}
      />
    );
  }

  // Mode CARTE (Stripe) : on garde la page d’origine
  return processName && !speculateTransactionInProgress ? (
    <CheckoutPageWithPayment
      config={config}
      routeConfiguration={routeConfiguration}
      intl={intl}
      history={history}
      processName={'default-booking'} // pour ?method=card on force le process carte
      sessionStorageKey={STORAGE_KEY}
      pageData={pageData}
      setPageData={setPageData}
      listingTitle={listingTitle}
      title={title}
      onSubmitCallback={onSubmitCallback}
      showListingImage={showListingImage}
      {...props}
    />
  ) : (
    <Page title={title} scrollingDisabled={scrollingDisabled}>
      <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
    </Page>
  );
};

const mapStateToProps = state => {
  const {
    listing,
    orderData,
    stripeCustomerFetched,
    speculateTransactionInProgress,
    speculateTransactionError,
    speculatedTransaction,
    isClockInSync,
    transaction,
    initiateInquiryError,
    initiateOrderError,
    confirmPaymentError,
  } = state.CheckoutPage;
  const { currentUser } = state.user;
  const { confirmCardPaymentError, paymentIntent, retrievePaymentIntentError } = state.stripe;
  return {
    scrollingDisabled: isScrollingDisabled(state),
    currentUser,
    stripeCustomerFetched,
    orderData,
    speculateTransactionInProgress,
    speculateTransactionError,
    speculatedTransaction,
    isClockInSync,
    transaction,
    listing,
    initiateInquiryError,
    initiateOrderError,
    confirmCardPaymentError,
    confirmPaymentError,
    paymentIntent,
    retrievePaymentIntentError,
  };
};

const mapDispatchToProps = dispatch => ({
  dispatch,
  fetchSpeculatedTransaction: (params, processAlias, txId, transitionName, isPrivileged) =>
    dispatch(speculateTransaction(params, processAlias, txId, transitionName, isPrivileged)),
  fetchStripeCustomer: () => dispatch(stripeCustomer()),
  onInquiryWithoutPayment: (params, processAlias, transitionName) =>
    dispatch(initiateInquiryWithoutPayment(params, processAlias, transitionName)),
  onInitiateOrder: (params, processAlias, transactionId, transitionName, isPrivileged) =>
    dispatch(initiateOrder(params, processAlias, transactionId, transitionName, isPrivileged)),
  onRetrievePaymentIntent: params => dispatch(retrievePaymentIntent(params)),
  onConfirmCardPayment: params => dispatch(confirmCardPayment(params)),
  onConfirmPayment: (transactionId, transitionName, transitionParams) =>
    dispatch(confirmPayment(transactionId, transitionName, transitionParams)),
  onSendMessage: params => dispatch(sendMessage(params)),
  onSavePaymentMethod: (stripeCustomer, stripePaymentMethodId) =>
    dispatch(savePaymentMethod(stripeCustomer, stripePaymentMethodId)),
});

const CheckoutPage = compose(
  connect(
    mapStateToProps,
    mapDispatchToProps
  )
)(EnhancedCheckoutPage);

CheckoutPage.setInitialValues = (initialValues, saveToSessionStorage = false) => {
  if (saveToSessionStorage) {
    const { listing, orderData } = initialValues;
    storeData(orderData, listing, null, STORAGE_KEY);
  }

  return setInitialValues(initialValues);
};

CheckoutPage.displayName = 'CheckoutPage';
export default CheckoutPage;
