import React, { useEffect, useState } from 'react';
import { compose } from 'redux';
import { connect } from 'react-redux';
import { useHistory } from 'react-router-dom';
import { useIntl } from 'react-intl';

// Import contexts and util modules
import { useConfiguration } from '../../context/configurationContext';
import { useRouteConfiguration } from '../../context/routeConfigurationContext';
import { userDisplayNameAsString } from '../../util/data';
import {
  NO_ACCESS_PAGE_INITIATE_TRANSACTIONS,
  NO_ACCESS_PAGE_USER_PENDING_APPROVAL,
} from '../../util/urlHelpers';
import { hasPermissionToInitiateTransactions, isUserAuthorized } from '../../util/userHelpers';
import { isErrorNoPermissionForInitiateTransactions } from '../../util/errors';
import { INQUIRY_PROCESS_NAME, resolveLatestProcessName } from '../../transactions/transaction';
import { requireListingImage } from '../../util/configHelpers';

// Import global thunk functions
import { isScrollingDisabled } from '../../ducks/ui.duck';
import { confirmCardPayment, retrievePaymentIntent } from '../../ducks/stripe.duck';
import { savePaymentMethod } from '../../ducks/paymentMethods.duck';

// Import shared components
import { NamedRedirect, Page } from '../../components';

// Session helpers file needs to be imported before CheckoutPageWithPayment and CheckoutPageWithInquiryProcess
import { storeData, clearData, handlePageData } from './CheckoutPageSessionHelpers';

// Import modules from this directory
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

const STORAGE_KEY = 'CheckoutPage';

// alias de ton process CASH (à adapter si besoin)
const CASH_PROCESS_LATEST_NAME = 'reloue-booking-cash';

const onSubmitCallback = () => {
  clearData(STORAGE_KEY);
};

const getProcessName = pageData => {
  const { transaction, listing } = pageData || {};
  const processName = transaction?.id
    ? transaction?.attributes?.processName
    : listing?.id
    ? listing?.attributes?.publicData?.transactionProcessAlias?.split('/')[0]
    : null;
  return resolveLatestProcessName(processName);
};

const EnhancedCheckoutPage = props => {
  const [pageData, setPageData] = useState({});
  const [isDataLoaded, setIsDataLoaded] = useState(false);

  // IMPORTANT : cette prop est injectée par les wrappers
  // CheckoutStripePage / CheckoutCashPage (ou par la page de choix).
  // 'stripe' | 'cash' ; par défaut on reste en stripe.
  const { forcedPaymentMethod = 'stripe' } = props;

  const config = useConfiguration();
  const routeConfiguration = useRouteConfiguration();
  const intl = useIntl();
  const history = useHistory();

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

    // Do not fetch extra data if user is not active (e.g. pending-approval.)
    if (isUserAuthorized(currentUser)) {
      // On ne charge Stripe/speculation Stripe que si:
      // - process ≠ inquiry
      // - ET on n'est pas en mode CASH
      if (getProcessName(data) !== INQUIRY_PROCESS_NAME && forcedPaymentMethod !== 'cash') {
        loadInitialDataForStripePayments({
          pageData: data || {},
          fetchSpeculatedTransaction,
          fetchStripeCustomer,
          config,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    currentUser,
    params,
    scrollingDisabled,
    speculateTransactionInProgress,
    onInquiryWithoutPayment,
    initiateOrderError,
  } = props;

  const baseProcessName = getProcessName(pageData);
  const isInquiryProcess = baseProcessName === INQUIRY_PROCESS_NAME;

  // Si on force CASH, on remplace le process utilisé par la page paiement
  const effectiveProcessName =
    forcedPaymentMethod === 'cash' ? CASH_PROCESS_LATEST_NAME : baseProcessName;

  // Handle redirection to ListingPage, if this is own listing or if required data is not available
  const listing = pageData?.listing;
  const isOwnListing = currentUser?.id && listing?.author?.id?.uuid === currentUser?.id?.uuid;
  const hasRequiredData = !!(listing?.id && listing?.author?.id && baseProcessName);
  const shouldRedirect = isDataLoaded && !(hasRequiredData && !isOwnListing);
  const shouldRedirectUnathorizedUser = isDataLoaded && !isUserAuthorized(currentUser);
  // Redirect if the user has no transaction rights
  const shouldRedirectNoTransactionRightsUser =
    isDataLoaded &&
    (!hasPermissionToInitiateTransactions(currentUser) ||
      isErrorNoPermissionForInitiateTransactions(initiateOrderError));

  // Redirect back to ListingPage if data is missing.
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

  const validListingTypes = config.listing.listingTypes;
  const foundListingTypeConfig = validListingTypes.find(
    conf => conf.listingType === listing?.attributes?.publicData?.listingType
  );
  const showListingImage = requireListingImage(foundListingTypeConfig);

  const listingTitle = listing?.attributes?.title;
  const authorDisplayName = userDisplayNameAsString(listing?.author, '');
  const title = baseProcessName
    ? intl.formatMessage(
        { id: `CheckoutPage.${baseProcessName}.title` },
        { listingTitle, authorDisplayName }
      )
    : 'Checkout page is loading data';

  return baseProcessName && isInquiryProcess ? (
    <CheckoutPageWithInquiryProcess
      config={config}
      routeConfiguration={routeConfiguration}
      intl={intl}
      history={history}
      processName={baseProcessName}
      pageData={pageData}
      listingTitle={listingTitle}
      title={title}
      onInquiryWithoutPayment={onInquiryWithoutPayment}
      onSubmitCallback={onSubmitCallback}
      showListingImage={showListingImage}
      {...props}
    />
  ) : baseProcessName && !isInquiryProcess && !speculateTransactionInProgress ? (
    <CheckoutPageWithPayment
      config={config}
      routeConfiguration={routeConfiguration}
      intl={intl}
      history={history}
      // Utiliser le process forcé si CASH
      processName={effectiveProcessName}
      sessionStorageKey={STORAGE_KEY}
      pageData={pageData}
      setPageData={setPageData}
      listingTitle={listingTitle}
      title={title}
      onSubmitCallback={onSubmitCallback}
      showListingImage={showListingImage}
      // on informe l'enfant du mode choisi pour masquer/afficher Stripe
      paymentMethod={forcedPaymentMethod}
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
