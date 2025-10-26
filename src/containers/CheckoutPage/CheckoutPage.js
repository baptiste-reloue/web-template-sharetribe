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
import { resolveLatestProcessName } from '../../transactions/transaction';
import { requireListingImage } from '../../util/configHelpers';

import { isScrollingDisabled } from '../../ducks/ui.duck';
import {
  confirmCardPayment,
  retrievePaymentIntent,
} from '../../ducks/stripe.duck';
import { savePaymentMethod } from '../../ducks/paymentMethods.duck';

import { NamedRedirect, Page } from '../../components';

import {
  storeData,
  clearData,
  handlePageData,
} from './CheckoutPageSessionHelpers';

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

const onSubmitCallback = () => {
  clearData(STORAGE_KEY);
};

// Sélection du process à afficher (et pour les titres, etc.)
const getProcessName = pageData => {
  const { transaction, listing, orderData } = pageData || {};

  // si on est déjà dans une transaction existante
  if (transaction?.id) {
    return resolveLatestProcessName(transaction?.attributes?.processName);
  }

  // sinon on se base sur l'annonce
  const listingAlias =
    listing?.attributes?.publicData?.transactionProcessAlias || null;
  const defaultProcessName = listingAlias
    ? listingAlias.split('/')[0]
    : null;

  // override si l'utilisateur a choisi CASH
  if (orderData?.paymentMethod === 'cash') {
    return resolveLatestProcessName('reloue-booking-cash');
  }

  // sinon c'est le process par défaut (Stripe)
  return resolveLatestProcessName(defaultProcessName);
};

// Petit bloc radio pour choisir CARTE ou CASH au début
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

      <p className={css.fieldInquiryMessage}>
        <FormattedMessage
          id="CheckoutPage.paymentMethod.description"
          defaultMessage="Le prix est identique. Si vous choisissez « Espèces », aucune carte ne sera demandée. Les dates seront bloquées après validation du propriétaire."
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
    const { orderData, listing, transaction } = props;

    // Récupère les infos qu'on a éventuellement mises en sessionStorage
    const data = handlePageData(
      { orderData, listing, transaction },
      STORAGE_KEY,
      history
    );

    setPageData(data || {});
    setIsDataLoaded(true);
  }, []);

  const {
    currentUser,
    params,
    scrollingDisabled,
    initiateOrderError,
  } = props;

  const processName = getProcessName(pageData);
  const listing = pageData?.listing;

  // sécurité: on empêche de réserver sa propre annonce & on check les data minimales
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
    return <NamedRedirect name="ListingPage" params={params} />;
  } else if (shouldRedirectUnauthorizedUser) {
    return (
      <NamedRedirect
        name="NoAccessPage"
        params={{
          missingAccessRight:
            NO_ACCESS_PAGE_USER_PENDING_APPROVAL,
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

  // Données pour l'UI (sidebar etc.)
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
  const title = intl.formatMessage(
    { id: `CheckoutPage.${processName}.title` },
    { listingTitle, authorDisplayName }
  );

  // A-t-il choisi cash ou carte ?
  const paymentMethodChosen =
    !!pageData?.orderData?.paymentMethod;

  // Étape 1 : pas encore choisi => on affiche juste le choix du mode de paiement
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

  // Étape 2 : il a choisi → on rend la page finale de paiement / cash request
  return (
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
  );
};

// === Redux wiring ===

const mapStateToProps = state => {
  const {
    listing,
    orderData,
    transaction,
    initiateOrderError,
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

  onInitiateOrder: (
    params,
    alias,
    txId,
    transition,
    isPriv
  ) =>
    dispatch(
      initiateOrder(
        params,
        alias,
        txId,
        transition,
        isPriv
      )
    ),

  onInitiateCashOrder: (params, txId) =>
    dispatch(initiateCashOrder(params, txId)),

  onRetrievePaymentIntent: params =>
    dispatch(retrievePaymentIntent(params)),

  onConfirmCardPayment: params =>
    dispatch(confirmCardPayment(params)),

  onConfirmPayment: (
    id,
    name,
    p
  ) => dispatch(confirmPayment(id, name, p)),

  onSendMessage: params => dispatch(sendMessage(params)),
  onSavePaymentMethod: (cust, pm) =>
    dispatch(savePaymentMethod(cust, pm)),
});

const CheckoutPage = compose(
  connect(mapStateToProps, mapDispatchToProps)
)(EnhancedCheckoutPage);

// Permet d'hydrater la sessionStorage quand on arrive sur le checkout
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
