import React, { useEffect, useMemo, useState } from 'react';
import { compose } from 'redux';
import { connect } from 'react-redux';
import { useHistory, useLocation } from 'react-router-dom';
import { useIntl } from '../../util/reactIntl';

// Contexts & utils
import { useConfiguration } from '../../context/configurationContext';
import { useRouteConfiguration } from '../../context/routeConfigurationContext';
import { userDisplayNameAsString, ensureTransaction } from '../../util/data';
import {
  NO_ACCESS_PAGE_INITIATE_TRANSACTIONS,
  NO_ACCESS_PAGE_USER_PENDING_APPROVAL,
  createSlug,
} from '../../util/urlHelpers';
import { hasPermissionToInitiateTransactions, isUserAuthorized } from '../../util/userHelpers';
import { isTransactionInitiateListingNotFoundError } from '../../util/errors';
import { getProcess, INQUIRY_PROCESS_NAME, resolveLatestProcessName } from '../../transactions/transaction';
import { requireListingImage } from '../../util/configHelpers';

// Ducks
import { isScrollingDisabled } from '../../ducks/ui.duck';

// Components
import { Page, H3, H4, Button, NamedRedirect, NamedLink, OrderBreakdown } from '../../components';

// Helpers (session + checkout)
import { storeData, handlePageData, clearData } from './CheckoutPageSessionHelpers';
import {
  bookingDatesMaybe,
  getFormattedTotalPrice,
  getTransactionTypeData,
  setOrderPageInitialValues,
} from './CheckoutPageTransactionHelpers.js';
import { getErrorMessages } from './ErrorMessages';

// Ducks locaux (pas de Stripe ici)
import {
  setInitialValues,
  speculateTransaction,
  initiateOrder,
  sendMessage,
} from './CheckoutPage.duck';

// Visuels
import CustomTopbar from './CustomTopbar';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';
import css from './CheckoutPage.module.css';

const STORAGE_KEY = 'CheckoutPage';

const onSubmitCallback = () => clearData(STORAGE_KEY);

// Construit les params pour l’initiation (sans Stripe)
const buildOrderParams = (pageData, config) => {
  const { listing } = pageData;
  const { listingType, unitType } = listing?.attributes?.publicData || {};

  // infos protégées utiles au process (comme pour la page Stripe)
  const protectedDataMaybe = {
    protectedData: {
      ...getTransactionTypeData(listingType, unitType, config),
    },
  };

  const quantity = pageData.orderData?.quantity;
  const seats = pageData.orderData?.seats;
  const quantityMaybe = quantity ? { quantity } : {};
  const seatsMaybe = seats ? { seats } : {};

  return {
    listingId: listing?.id,
    ...quantityMaybe,
    ...seatsMaybe,
    ...bookingDatesMaybe(pageData.orderData?.bookingDates),
    ...protectedDataMaybe,
  };
};

// Déduit le process de base à partir de listing/transaction
const baseProcessName = pageData => {
  const { transaction, listing } = pageData || {};
  const processName = transaction?.id
    ? transaction?.attributes?.processName
    : listing?.attributes?.publicData?.transactionProcessAlias?.split('/')[0];
  return resolveLatestProcessName(processName);
};

// Spéculation (sans Stripe) pour afficher la tarification
const fetchSpeculatedIfNeeded = (pageData, config, fetchSpeculatedTransaction) => {
  const tx = pageData?.transaction || null;
  const processName =
    tx?.attributes?.processName ||
    pageData?.listing?.attributes?.publicData?.transactionProcessAlias?.split('/')[0];
  const process = processName ? getProcess(processName) : null;

  if (!pageData?.listing?.id || !pageData?.orderData || !process) return;

  // Transition de demande SANS paiement
  const isInquiryInPaymentProcess = tx?.attributes?.lastTransition === process.transitions.INQUIRE;
  // Par convention de Sharetribe, ces deux clés existent sur un process de booking sans Stripe :
  // REQUEST et REQUEST_AFTER_INQUIRY
  const requestTransition = isInquiryInPaymentProcess
    ? (process.transitions.REQUEST_AFTER_INQUIRY || process.transitions.REQUEST)
    : process.transitions.REQUEST;

  const isPrivileged = process.isPrivileged(requestTransition);
  const processAlias = pageData.listing.attributes.publicData?.transactionProcessAlias;
  const transactionId = tx ? tx.id : null;

  const orderParams = buildOrderParams(pageData, config);

  fetchSpeculatedTransaction(orderParams, processAlias, transactionId, requestTransition, isPrivileged);
};

const CheckoutCashPageImpl = props => {
  const intl = useIntl();
  const history = useHistory();
  const location = useLocation();
  const config = useConfiguration();
  const routeConfiguration = useRouteConfiguration();

  const [pageData, setPageData] = useState({});
  const [isDataLoaded, setIsDataLoaded] = useState(false);

  // Récup data (ListingPage → session)
  useEffect(() => {
    const initial = {
      orderData: props.orderData,
      listing: props.listing,
      transaction: props.transaction,
    };
    const data = handlePageData(initial, STORAGE_KEY, history);
    setPageData(data || {});
    setIsDataLoaded(true);

    // Speculative pricing
    fetchSpeculatedIfNeeded(data || {}, config, props.fetchSpeculatedTransaction);

  }, []);

  // Sécurité & redirections
  const { currentUser, scrollingDisabled, speculateTransactionError, initiateOrderError } = props;

  const listing = pageData?.listing;
  const isOwnListing =
    currentUser?.id && listing?.author?.id?.uuid === currentUser?.id?.uuid;

  const discoveredProcess = baseProcessName(pageData);
  const processName = 'reloue-booking-cash'; // forcé sur cette page
  const hasRequiredData = !!(listing?.id && listing?.author?.id && processName);

  const shouldRedirect = isDataLoaded && !(hasRequiredData && !isOwnListing);
  const shouldRedirectUnathorizedUser = isDataLoaded && !isUserAuthorized(currentUser);
  const shouldRedirectNoTransactionRightsUser =
    isDataLoaded &&
    (!hasPermissionToInitiateTransactions(currentUser) ||
      !!initiateOrderError);

  if (shouldRedirect) {
    return <NamedRedirect name="ListingPage" params={props.params} />;
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

  // Titre et infos
  const listingTitle = listing?.attributes?.title;
  const authorDisplayName = userDisplayNameAsString(listing?.author, '');
  const title = intl.formatMessage(
    { id: `CheckoutPage.${processName}.title` },
    { listingTitle, authorDisplayName }
  );

  // Image & breakdown
  const validListingTypes = config.listing.listingTypes;
  const foundListingTypeConfig = validListingTypes.find(
    conf => conf.listingType === listing?.attributes?.publicData?.listingType
  );
  const showListingImage = requireListingImage(foundListingTypeConfig);

  const existingTransaction = ensureTransaction(props.transaction);
  const speculatedTransaction = ensureTransaction(props.speculatedTransaction, {}, null);
  const tx =
    existingTransaction?.attributes?.lineItems?.length > 0
      ? existingTransaction
      : speculatedTransaction;

  const timeZone = listing?.attributes?.availabilityPlan?.timezone;
  const txBookingMaybe = tx?.booking?.id ? { booking: tx.booking, timeZone } : {};

  const breakdown =
    tx?.id && tx?.attributes?.lineItems?.length > 0 ? (
      <OrderBreakdown
        className={css.orderBreakdown}
        userRole="customer"
        transaction={tx}
        {...txBookingMaybe}
        currency={config.currency}
        marketplaceName={config.marketplaceName}
      />
    ) : null;

  const totalPrice =
    tx?.attributes?.lineItems?.length > 0 ? getFormattedTotalPrice(tx, intl) : null;

  const firstImage = listing?.images?.length > 0 ? listing.images[0] : null;

  // Erreurs génériques pour le header
  const listingNotFound =
    isTransactionInitiateListingNotFoundError(speculateTransactionError) ||
    isTransactionInitiateListingNotFoundError(initiateOrderError);

  const listingLink = (
    <NamedLink
      name="ListingPage"
      params={{ id: listing?.id?.uuid, slug: createSlug(listingTitle) }}
    >
      {intl.formatMessage({ id: 'CheckoutPage.errorlistingLinkText' })}
    </NamedLink>
  );

  const errorMessages = getErrorMessages(
    listingNotFound,
    initiateOrderError,
    false, // isPaymentExpired (pas de Stripe ici)
    null, // retrievePaymentIntentError
    speculateTransactionError,
    listingLink
  );

  // Formulaire minimal (message optionnel)
  const [message, setMessage] = useState('');

  const onSubmit = () => {
    const process = getProcess(processName);

    const tx = pageData?.transaction || null;
    const isInquiryInPaymentProcess = tx?.attributes?.lastTransition === process.transitions.INQUIRE;
    const requestTransition = isInquiryInPaymentProcess
      ? (process.transitions.REQUEST_AFTER_INQUIRY || process.transitions.REQUEST)
      : process.transitions.REQUEST;
    const isPrivileged = process.isPrivileged(requestTransition);

    const orderParams = buildOrderParams(pageData, config);
    const processAlias = 'reloue-booking-cash/release-1';
    const transactionId = tx ? tx.id : null;

    props
      .onInitiateOrder(orderParams, processAlias, transactionId, requestTransition, isPrivileged)
      .then(order => {
        const orderId = order.id;
        // message initial
        return props
          .onSendMessage({ id: orderId, message })
          .then(({ messageSuccess }) => {
            const initialValues = {
              initialMessageFailedToTransaction: messageSuccess ? null : orderId,
            };
            setOrderPageInitialValues(initialValues, routeConfiguration, props.dispatch);
            onSubmitCallback();

            const detailsPath = {
              name: 'OrderDetailsPage',
              params: { id: orderId.uuid },
            };
            const path = props.history && props.history.push
              ? null
              : null;

            const orderDetailsPath = `/order/${orderId.uuid}`;
            props.history.push(orderDetailsPath);
          });
      })
      .catch(e => {
        // eslint-disable-next-line no-console
        console.error('initiate cash order failed', e);
      });
  };

  const goBackToListing = () => {
    if (listing?.id) {
      history.push(`/l/${createSlug(listingTitle)}/${listing.id.uuid}`);
    } else {
      history.goBack();
    }
  };

  return (
    <Page title={title} scrollingDisabled={scrollingDisabled}>
      <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
      <div className={css.contentContainer}>
        <MobileListingImage
          listingTitle={listingTitle}
          author={listing?.author}
          firstImage={firstImage}
          layoutListingImageConfig={config.layout.listingImage}
          showListingImage={showListingImage}
        />

        <div className={css.orderFormContainer}>
          <div className={css.headingContainer}>
            <H3 as="h1" className={css.heading}>
              {title}
            </H3>
            <H4 as="h2" className={css.detailsHeadingMobile}>
              {intl.formatMessage({ id: 'CheckoutPage.listingTitle' }, { listingTitle })}
            </H4>
          </div>

          <MobileOrderBreakdown
            speculateTransactionErrorMessage={errorMessages.speculateTransactionErrorMessage}
            breakdown={breakdown}
            // pas de priceVariant spécifique ici, on laisse vide
          />

          <section className={css.paymentContainer}>
            {/* Messages d’erreur génériques */}
            {errorMessages.initiateOrderErrorMessage}
            {errorMessages.listingNotFoundErrorMessage}
            {errorMessages.speculateErrorMessage}

            {/* Formulaire simple */}
            <div className={css.paymentForm}>
              <label className={css.label} htmlFor="messageToProvider">
                {intl.formatMessage({ id: 'CheckoutPage.initialMessageLabel' })}
              </label>
              <textarea
                id="messageToProvider"
                className={css.textarea}
                placeholder={intl.formatMessage({ id: 'CheckoutPage.initialMessagePlaceholder' })}
                value={message}
                onChange={e => setMessage(e.target.value)}
                rows={4}
              />

              <div className={css.actionRow}>
                <Button className={css.submitButton} onClick={onSubmit}>
                  {intl.formatMessage({ id: 'CheckoutPage.cash.submit' })}
                </Button>

                <Button className={css.secondaryButton} type="button" onClick={goBackToListing}>
                  ← {intl.formatMessage({ id: 'CheckoutPage.backToListing' })}
                </Button>
              </div>
            </div>
          </section>
        </div>

        <DetailsSideCard
          listing={listing}
          listingTitle={listingTitle}
          author={listing?.author}
          firstImage={firstImage}
          layoutListingImageConfig={config.layout.listingImage}
          speculateTransactionErrorMessage={errorMessages.speculateTransactionErrorMessage}
          isInquiryProcess={false}
          processName={processName}
          breakdown={breakdown}
          showListingImage={showListingImage}
          intl={intl}
        />
      </div>
    </Page>
  );
};

// ---------- Redux wiring ----------

const mapStateToProps = state => {
  const {
    listing,
    orderData,
    speculatedTransaction,
    speculateTransactionError,
    transaction,
    initiateOrderError,
  } = state.CheckoutPage;
  const { currentUser } = state.user;

  return {
    scrollingDisabled: isScrollingDisabled(state),
    currentUser,
    listing,
    orderData,
    speculatedTransaction,
    speculateTransactionError,
    transaction,
    initiateOrderError,
  };
};

const mapDispatchToProps = dispatch => ({
  dispatch,
  fetchSpeculatedTransaction: (params, processAlias, txId, transitionName, isPrivileged) =>
    dispatch(speculateTransaction(params, processAlias, txId, transitionName, isPrivileged)),
  onInitiateOrder: (params, processAlias, transactionId, transitionName, isPrivileged) =>
    dispatch(initiateOrder(params, processAlias, transactionId, transitionName, isPrivileged)),
  onSendMessage: params => dispatch(sendMessage(params)),
});

const CheckoutCashPage = compose(
  connect(mapStateToProps, mapDispatchToProps)
)(CheckoutCashPageImpl);

CheckoutCashPage.setInitialValues = (initialValues, saveToSessionStorage = false) => {
  if (saveToSessionStorage) {
    const { listing, orderData } = initialValues || {};
    storeData(orderData, listing, null, STORAGE_KEY);
  }
  return setInitialValues(initialValues);
};

CheckoutCashPage.displayName = 'CheckoutCashPage';
export default CheckoutCashPage;
