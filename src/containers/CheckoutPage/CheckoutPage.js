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
import {
  isErrorNoPermissionForInitiateTransactions,
} from '../../util/errors';
import {
  INQUIRY_PROCESS_NAME,
  resolveLatestProcessName,
} from '../../transactions/transaction';
import { requireListingImage } from '../../util/configHelpers';

import { isScrollingDisabled } from '../../ducks/ui.duck';
import {
  confirmCardPayment,
  retrievePaymentIntent,
} from '../../ducks/stripe.duck';
import { savePaymentMethod } from '../../ducks/paymentMethods.duck';

import { NamedRedirect, Page } from '../../components';

// Session helpers
import {
  storeData,
  clearData,
  handlePageData,
} from './CheckoutPageSessionHelpers';

// Ducks / thunks
import {
  initiateOrder,
  setInitialValues,
  speculateTransaction,
  stripeCustomer,
  confirmPayment,
  sendMessage,
  initiateInquiryWithoutPayment,
  initiateCashOrder,
} from './CheckoutPage.duck';

import CustomTopbar from './CustomTopbar';
import CheckoutPageWithPayment from './CheckoutPageWithPayment';
import CheckoutPageWithInquiryProcess from './CheckoutPageWithInquiryProcess';

import css from './CheckoutPage.module.css';

const STORAGE_KEY = 'CheckoutPage';

const onSubmitCallback = () => {
  clearData(STORAGE_KEY);
};

/**
 * Helper: fetch Stripe customer + speculate transaction for Stripe flows.
 * On l'avait avant sous forme d'export dans CheckoutPageWithPayment.js.
 * On la garde ici désormais.
 */
const loadInitialDataForStripePayments = ({
  pageData,
  fetchSpeculatedTransaction,
  fetchStripeCustomer,
  config,
}) => {
  const listing = pageData?.listing;
  const transaction = pageData?.transaction;
  const orderData = pageData?.orderData;

  // Récupération du processAlias depuis l'annonce
  const processAlias =
    listing?.attributes?.publicData?.transactionProcessAlias || null;

  // transaction existante ?
  const transactionId = transaction?.id || null;

  // On va chercher la première transition Stripe côté booking
  // Sur Flex par défaut pour booking Stripe : 'transition/request-payment'
  // Chez toi => vérifie selon ton process Stripe "default-booking"
  const transitionName = 'transition/request-payment';
  const isPrivilegedTransition = false;

  // orderData contient par ex. bookingDates, quantity, deliveryMethod...
  const orderParams = orderData || {};

  // 1) on prédit le prix / récap
  if (processAlias && orderParams) {
    fetchSpeculatedTransaction(
      orderParams,
      processAlias,
      transactionId,
      transitionName,
      isPrivilegedTransition
    );
  }

  // 2) on récupère le client Stripe
  fetchStripeCustomer();
};

/**
 * Version modifiée de getProcessName :
 * - si l'utilisateur a choisi "cash", on force le processName à "reloue-booking-cash"
 * - sinon on lit le process de l'annonce ou celui de la transaction existante
 */
const getProcessName = pageData => {
  const { transaction, listing, orderData } = pageData || {};

  // Si la transaction existe déjà → on respecte le process de la transaction
  if (transaction?.id) {
    const processName = transaction?.attributes?.processName;
    return resolveLatestProcessName(processName);
  }

  // Cas nouvelle transaction
  const listingAlias = listing?.id
    ? listing?.attributes?.publicData?.transactionProcessAlias
    : null;
  const defaultProcessName = listingAlias
    ? listingAlias.split('/')[0]
    : null;

  // Override si cash
  if (orderData?.paymentMethod === 'cash') {
    // 'reloue-booking-cash/release-1' -> racine processName = 'reloue-booking-cash'
    return resolveLatestProcessName('reloue-booking-cash');
  }

  return resolveLatestProcessName(defaultProcessName);
};

const PaymentMethodSelection = ({ pageData, setPageData }) => {
  const paymentMethod = pageData?.orderData?.paymentMethod || null;

  const setAndStore = method => {
    const updatedPageData = {
      ...pageData,
      orderData: {
        ...pageData.orderData,
        paymentMethod: method,
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
    const {
      currentUser,
      orderData,
      listing,
      transaction,
      fetchSpeculatedTransaction,
      fetchStripeCustomer,
    } = props;

    // recharge les données depuis sessionStorage si existantes
    const initialData = { orderData, listing, transaction };
    const data = handlePageData(initialData, STORAGE_KEY, history);

    setPageData(data || {});
    setIsDataLoaded(true);

    // si l'utilisateur a les droits ET que le process actif est un process "Stripe"
    if (isUserAuthorized(currentUser)) {
      const activeProcessName = getProcessName(data);

      if (activeProcessName !== INQUIRY_PROCESS_NAME) {
        // Ici on ne veut charger Stripe customer & speculate
        // QUE si le mode sélectionné est "card".
        const method = data?.orderData?.paymentMethod;
        if (method === 'card') {
          loadInitialDataForStripePayments({
            pageData: data || {},
            fetchSpeculatedTransaction,
            fetchStripeCustomer,
            config,
          });
        }
      }
    }
  }, []);

  const {
    currentUser,
    params,
    scrollingDisabled,
    speculateTransactionInProgress,
    onInquiryWithoutPayment,
    initiateOrderError,
  } = props;

  const processName = getProcessName(pageData);
  const isInquiryProcess = processName === INQUIRY_PROCESS_NAME;

  // Guard rails / redirections
  const listing = pageData?.listing;
  const isOwnListing =
    currentUser?.id &&
    listing?.author?.id?.uuid === currentUser?.id?.uuid;

  const hasRequiredData = !!(
    listing?.id &&
    listing?.author?.id &&
    processName
  );

  const shouldRedirect =
    isDataLoaded && !(hasRequiredData && !isOwnListing);

  const shouldRedirectUnauthorizedUser =
    isDataLoaded && !isUserAuthorized(currentUser);

  const shouldRedirectNoTransactionRightsUser =
    isDataLoaded &&
    (!hasPermissionToInitiateTransactions(currentUser) ||
      isErrorNoPermissionForInitiateTransactions(
        initiateOrderError
      ));

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
        params={{
          missingAccessRight: NO_ACCESS_PAGE_USER_PENDING_APPROVAL,
        }}
      />
    );
  } else if (shouldRedirectNoTransactionRightsUser) {
    return (
      <NamedRedirect
        name="NoAccessPage"
        params={{
          missingAccessRight:
            NO_ACCESS_PAGE_INITIATE_TRANSACTIONS,
        }}
      />
    );
  }

  // Affichage image etc.
  const validListingTypes = config.listing.listingTypes;
  const foundListingTypeConfig = validListingTypes.find(
    conf =>
      conf.listingType ===
      listing?.attributes?.publicData?.listingType
  );
  const showListingImage = requireListingImage(
    foundListingTypeConfig
  );

  const listingTitle = listing?.attributes?.title;
  const authorDisplayName = userDisplayNameAsString(
    listing?.author,
    ''
  );

  const title = processName
    ? intl.formatMessage(
        { id: `CheckoutPage.${processName}.title` },
        { listingTitle, authorDisplayName }
      )
    : 'Checkout page is loading data';

  // L'utilisateur a-t-il déjà choisi carte / espèces ?
  const paymentMethodChosen =
    !!pageData?.orderData?.paymentMethod;

  if (!paymentMethodChosen) {
    return (
      <Page
        title={title}
        scrollingDisabled={scrollingDisabled}
      >
        <CustomTopbar
          intl={intl}
          linkToExternalSite={config?.topbar?.logoLink}
        />
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
            <PaymentMethodSelection
              pageData={pageData}
              setPageData={setPageData}
            />
          </div>
        </div>
      </Page>
    );
  }

  // rendu principal
  return processName && isInquiryProcess ? (
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
  ) : processName &&
    !isInquiryProcess &&
    !speculateTransactionInProgress ? (
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
    <Page
      title={title}
      scrollingDisabled={scrollingDisabled}
    >
      <CustomTopbar
        intl={intl}
        linkToExternalSite={config?.topbar?.logoLink}
      />
    </Page>
  );
};

// === Redux wiring ===

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
  const {
    confirmCardPaymentError,
    paymentIntent,
    retrievePaymentIntentError,
  } = state.stripe;

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
  fetchSpeculatedTransaction: (
    params,
    processAlias,
    txId,
    transitionName,
    isPrivileged
  ) =>
    dispatch(
      speculateTransaction(
        params,
        processAlias,
        txId,
        transitionName,
        isPrivileged
      )
    ),
  fetchStripeCustomer: () => dispatch(stripeCustomer()),

  onInquiryWithoutPayment: (
    params,
    processAlias,
    transitionName
  ) =>
    dispatch(
      initiateInquiryWithoutPayment(
        params,
        processAlias,
        transitionName
      )
    ),

  onInitiateOrder: (
    params,
    processAlias,
    transactionId,
    transitionName,
    isPrivileged
  ) =>
    dispatch(
      initiateOrder(
        params,
        processAlias,
        transactionId,
        transitionName,
        isPrivileged
      )
    ),

  onInitiateCashOrder: (params, transactionId) =>
    dispatch(initiateCashOrder(params, transactionId)),

  onRetrievePaymentIntent: params =>
    dispatch(retrievePaymentIntent(params)),

  onConfirmCardPayment: params =>
    dispatch(confirmCardPayment(params)),

  onConfirmPayment: (
    transactionId,
    transitionName,
    transitionParams
  ) =>
    dispatch(
      confirmPayment(
        transactionId,
        transitionName,
        transitionParams
      )
    ),

  onSendMessage: params => dispatch(sendMessage(params)),
  onSavePaymentMethod: (
    stripeCustomer,
    stripePaymentMethodId
  ) =>
    dispatch(
      savePaymentMethod(
        stripeCustomer,
        stripePaymentMethodId
      )
    ),
});

const CheckoutPage = compose(
  connect(mapStateToProps, mapDispatchToProps)
)(EnhancedCheckoutPage);

// static helper pour préremplir session storage au moment
// où tu arrives sur CheckoutPage la première fois
CheckoutPage.setInitialValues = (
  initialValues,
  saveToSessionStorage = false
) => {
  if (saveToSessionStorage) {
    const { listing, orderData } = initialValues;
    storeData(orderData, listing, null, STORAGE_KEY);
  }

  return setInitialValues(initialValues);
};

CheckoutPage.displayName = 'CheckoutPage';

export default CheckoutPage;
