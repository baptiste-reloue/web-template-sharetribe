import React, { useEffect, useState } from 'react';
import { compose } from 'redux';
import { connect } from 'react-redux';
import { useHistory } from 'react-router-dom';
import { useIntl, FormattedMessage } from 'react-intl';

import { useConfiguration } from '../../context/configurationContext';
import { useRouteConfiguration } from '../../context/routeConfigurationContext';
import { userDisplayNameAsString } from '../../util/data';
import {
  NO_ACCESS_PAGE_INITIATE_TRANSACTIONS,
  NO_ACCESS_PAGE_USER_PENDING_APPROVAL,
} from '../../util/urlHelpers';
import {
  hasPermissionToInitiateTransactions,
  isUserAuthorized,
} from '../../util/userHelpers';
import { isErrorNoPermissionForInitiateTransactions } from '../../util/errors';
import { resolveLatestProcessName } from '../../transactions/transaction';
import { requireListingImage } from '../../util/configHelpers';

import { isScrollingDisabled } from '../../ducks/ui.duck';
import { confirmCardPayment, retrievePaymentIntent } from '../../ducks/stripe.duck';
import { savePaymentMethod } from '../../ducks/paymentMethods.duck';

import { NamedRedirect, Page } from '../../components';

import { storeData, clearData, handlePageData } from './CheckoutPageSessionHelpers';

import {
  initiateOrder,
  setInitialValues,
  confirmPayment,
  sendMessage,
  initiateCashOrder,
} from './CheckoutPage.duck';

import CustomTopbar from './CustomTopbar';
import CheckoutPageWithPayment from './CheckoutPageWithPayment';

import css from './CheckoutPage.module.css';

const STORAGE_KEY = 'CheckoutPage';

const onSubmitCallback = () => {
  clearData(STORAGE_KEY);
};

/**
 * Choisit le process côté front :
 *  - si paiement = cash -> processName 'reloue-booking-cash'
 *  - sinon -> processName par défaut du listing (ex: 'default-booking')
 *  - si transaction existe déjà -> processName de cette transaction
 *
 * Le "processName" (ex: "default-booking") est la partie avant "/release-1".
 */
const getProcessName = pageData => {
  const { transaction, listing, orderData } = pageData || {};

  // Si une transaction existe déjà -> on respecte son processName
  if (transaction?.id) {
    const processName = transaction?.attributes?.processName;
    return resolveLatestProcessName(processName);
  }

  // Sinon on part du process attaché à l'annonce
  const listingAlias = listing?.id
    ? listing?.attributes?.publicData?.transactionProcessAlias // ex: "default-booking/release-1"
    : null;

  const defaultProcessName = listingAlias ? listingAlias.split('/')[0] : null;

  // Override si cash
  if (orderData?.paymentMethod === 'cash') {
    // "reloue-booking-cash/release-1" => nom racine "reloue-booking-cash"
    return resolveLatestProcessName('reloue-booking-cash');
  }

  // Sinon paiement carte Stripe -> process par défaut du listing (ex: default-booking)
  return resolveLatestProcessName(defaultProcessName);
};

/**
 * Petit composant pour l'étape où l'utilisateur choisit CARTE ou ESPECES.
 * On enregistre le choix dans pageData.orderData.paymentMethod,
 * et on le persiste dans sessionStorage via storeData.
 */
const PaymentMethodSelection = ({ pageData, setPageData }) => {
  const paymentMethod = pageData?.orderData?.paymentMethod || null;

  const setAndStore = method => {
    const updatedPageData = {
      ...pageData,
      orderData: {
        ...pageData.orderData,
        paymentMethod: method, // 'card' ou 'cash'
      },
    };

    setPageData(updatedPageData);

    storeData(
      updatedPageData.orderData,
      updatedPageData.listing,
      updatedPageData.transaction,
      STORAGE_KEY
    );
  };

  return (
    <div className={css.paymentMethodSelection}>
      <h3 className={css.sectionHeading}>
        <FormattedMessage
          id="CheckoutPage.paymentMethod.title"
          defaultMessage="Choix du mode de paiement"
        />
      </h3>

      <div className={css.field}>
        <label>
          <input
            type="radio"
            name="paymentMethod"
            value="card"
            checked={paymentMethod === 'card'}
            onChange={() => setAndStore('card')}
          />{' '}
          <FormattedMessage
            id="CheckoutPage.paymentMethod.card"
            defaultMessage="Par carte (Stripe)"
          />
        </label>
      </div>

      <div className={css.field}>
        <label>
          <input
            type="radio"
            name="paymentMethod"
            value="cash"
            checked={paymentMethod === 'cash'}
            onChange={() => setAndStore('cash')}
          />{' '}
          <FormattedMessage
            id="CheckoutPage.paymentMethod.cash"
            defaultMessage="En espèces (paiement lors de la remise)"
          />
        </label>
      </div>

      <p className={css.fieldInquiryMessage}>
        <FormattedMessage
          id="CheckoutPage.paymentMethod.description"
          defaultMessage="Le prix est identique. Si vous choisissez « Espèces », aucune carte ne sera demandée : votre demande sera envoyée au propriétaire et les dates seront bloquées. Le propriétaire verra le mode de paiement indiqué."
        />
      </p>
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

  useEffect(() => {
    const { currentUser, orderData, listing, transaction } = props;

    // Recharge les données (dates, mode de livraison, etc.) depuis sessionStorage si déjà existantes.
    const initialData = { orderData, listing, transaction };
    const data = handlePageData(initialData, STORAGE_KEY, history);

    setPageData(data || {});
    setIsDataLoaded(true);

    // plus de préchargement Stripe ici -> Stripe se gère dans CheckoutPageWithPayment au moment du submit
    if (isUserAuthorized(currentUser)) {
      // rien de spécial ici pour l'instant
    }
  }, []);

  const {
    currentUser,
    params,
    scrollingDisabled,
    speculateTransactionInProgress,
    initiateOrderError,
  } = props;

  const processName = getProcessName(pageData);

  // --- Guards & redirections ---

  const listing = pageData?.listing;
  const isOwnListing =
    currentUser?.id && listing?.author?.id?.uuid === currentUser?.id?.uuid;

  const hasRequiredData = !!(
    listing?.id &&
    listing?.author?.id &&
    processName
  );

  const shouldRedirect = isDataLoaded && !(hasRequiredData && !isOwnListing);

  const shouldRedirectUnauthorizedUser =
    isDataLoaded && !isUserAuthorized(currentUser);

  const shouldRedirectNoTransactionRightsUser =
    isDataLoaded &&
    (!hasPermissionToInitiateTransactions(currentUser) ||
      isErrorNoPermissionForInitiateTransactions(initiateOrderError));

  if (shouldRedirect) {
    console.error(
      'Missing or invalid data for checkout, redirecting back to listing page.',
      { listing }
    );
    return <NamedRedirect name="ListingPage" params={params} />;
  } else if (shouldRedirectUnauthorizedUser) {
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

  // Données d'affichage pour le sidecard
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

  // L'utilisateur a-t-il choisi CARTE ou CASH ?
  const paymentMethodChosen = !!pageData?.orderData?.paymentMethod;

  if (!paymentMethodChosen) {
    // Étape 1 : affichage du choix de paiement
    return (
      <Page title={title} scrollingDisabled={scrollingDisabled}>
        <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
        <div className={css.contentContainer}>
          <div className={css.orderFormContainer}>
            <div className={css.headingContainer}>
              <h1 className={css.heading}>
                <FormattedMessage
                  id="CheckoutPage.selectPaymentHeading"
                  defaultMessage="Mode de paiement"
                />
              </h1>
            </div>
            <PaymentMethodSelection pageData={pageData} setPageData={setPageData} />
          </div>
        </div>
      </Page>
    );
  }

  // Étape 2 : rendu du checkout final (Stripe OU Cash)
  return processName && !speculateTransactionInProgress ? (
    <CheckoutPageWithPayment
      config={config}
      routeConfiguration={routeConfiguration}
      intl={intl}
      history={history}
      processName={processName}
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

// =============== Redux connect ===============

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
    initiateOrderError,
    confirmCardPaymentError,
    confirmPaymentError,
    paymentIntent,
    retrievePaymentIntentError,
  };
};

const mapDispatchToProps = dispatch => ({
  dispatch,

  onInitiateOrder: (params, processAlias, transactionId, transitionName, isPrivileged) =>
    dispatch(
      initiateOrder(params, processAlias, transactionId, transitionName, isPrivileged)
    ),

  onInitiateCashOrder: (params, transactionId) =>
    dispatch(initiateCashOrder(params, transactionId)),

  onRetrievePaymentIntent: params => dispatch(retrievePaymentIntent(params)),

  onConfirmCardPayment: params => dispatch(confirmCardPayment(params)),

  onConfirmPayment: (transactionId, transitionName, transitionParams) =>
    dispatch(confirmPayment(transactionId, transitionName, transitionParams)),

  onSendMessage: params => dispatch(sendMessage(params)),
  onSavePaymentMethod: (stripeCustomer, stripePaymentMethodId) =>
    dispatch(savePaymentMethod(stripeCustomer, stripePaymentMethodId)),
});

const CheckoutPage = compose(connect(mapStateToProps, mapDispatchToProps))(
  EnhancedCheckoutPage
);

CheckoutPage.setInitialValues = (initialValues, saveToSessionStorage = false) => {
  if (saveToSessionStorage) {
    const { listing, orderData } = initialValues;
    storeData(orderData, listing, null, STORAGE_KEY);
  }

  return setInitialValues(initialValues);
};

CheckoutPage.displayName = 'CheckoutPage';

export default CheckoutPage;
