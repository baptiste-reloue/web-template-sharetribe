// src/containers/CheckoutPage/CheckoutCashPage.js
import React, { useState } from 'react';

// Contexts & utils
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { propTypes } from '../../util/types';
import { ensureTransaction } from '../../util/data';
import { createSlug } from '../../util/urlHelpers';
import { isTransactionInitiateListingNotFoundError } from '../../util/errors';
import { getProcess, isBookingProcessAlias } from '../../transactions/transaction';

// Shared components
import { H3, H4, NamedLink, OrderBreakdown, Page, Button } from '../../components';

import {
  bookingDatesMaybe,
  getFormattedTotalPrice,
  getShippingDetailsMaybe,
  getTransactionTypeData,
  hasTransactionPassedPendingPayment,
} from './CheckoutPageTransactionHelpers.js';
import { getErrorMessages } from './ErrorMessages';

import CustomTopbar from './CustomTopbar';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import css from './CheckoutPage.module.css';

// -----------------------------
// Helpers (reprennent la logique de CheckoutPageWithPayment)
// -----------------------------

const capitalizeString = s => `${s.charAt(0).toUpperCase()}${s.substr(1)}`;

// Préfixe les propriétés du priceVariant pour les stocker en protectedData
const prefixPriceVariantProperties = priceVariant => {
  if (!priceVariant) return {};
  const entries = Object.entries(priceVariant).map(([key, value]) => {
    return [`priceVariant${capitalizeString(key)}`, value];
  });
  return Object.fromEntries(entries);
};

/**
 * Construit orderParams (identique à CheckoutPageWithPayment, sans params Stripe)
 */
const getOrderParams = (pageData, shippingDetails, optionalPaymentParams, config) => {
  const quantity = pageData.orderData?.quantity;
  const quantityMaybe = quantity ? { quantity } : {};
  const seats = pageData.orderData?.seats;
  const seatsMaybe = seats ? { seats } : {};
  const deliveryMethod = pageData.orderData?.deliveryMethod;
  const deliveryMethodMaybe = deliveryMethod ? { deliveryMethod } : {};
  const { listingType, unitType, priceVariants } = pageData?.listing?.attributes?.publicData || {};

  const priceVariantName = pageData.orderData?.priceVariantName;
  const priceVariantNameMaybe = priceVariantName ? { priceVariantName } : {};
  const priceVariant = priceVariants?.find(pv => pv.name === priceVariantName);
  const priceVariantMaybe = priceVariant ? prefixPriceVariantProperties(priceVariant) : {};

  const protectedDataMaybe = {
    protectedData: {
      ...getTransactionTypeData(listingType, unitType, config),
      ...deliveryMethodMaybe,
      ...shippingDetails,
      ...priceVariantMaybe,
      paymentMethod: 'cash', // indicateur côté back
    },
  };

  return {
    listingId: pageData?.listing?.id,
    ...deliveryMethodMaybe,
    ...quantityMaybe,
    ...seatsMaybe,
    ...bookingDatesMaybe(pageData.orderData?.bookingDates),
    ...priceVariantNameMaybe,
    ...protectedDataMaybe,
    ...optionalPaymentParams, // (vide pour cash)
  };
};

const fetchSpeculatedTransactionIfNeeded = (orderParams, pageData, fetchSpeculatedTransaction) => {
  const tx = pageData ? pageData.transaction : null;
  const pageDataListing = pageData.listing;
  const processName =
    tx?.attributes?.processName ||
    pageDataListing?.attributes?.publicData?.transactionProcessAlias?.split('/')[0];
  const process = processName ? getProcess(processName) : null;

  const shouldFetchSpeculatedTransaction =
    !!pageData?.listing?.id &&
    !!pageData.orderData &&
    !!process &&
    !hasTransactionPassedPendingPayment(tx, process);

  if (shouldFetchSpeculatedTransaction) {
    const processAlias = pageData.listing.attributes.publicData?.transactionProcessAlias;
    const transactionId = tx ? tx.id : null;
    const isInquiryInPaymentProcess =
      tx?.attributes?.lastTransition === process.transitions.INQUIRE;

    const requestTransition = isInquiryInPaymentProcess
      ? process.transitions.REQUEST_PAYMENT_AFTER_INQUIRY
      : process.transitions.REQUEST_PAYMENT;
    const isPrivileged = process.isPrivileged(requestTransition);

    fetchSpeculatedTransaction(
      orderParams,
      processAlias,
      transactionId,
      requestTransition,
      isPrivileged
    );
  }
};

/**
 * Charge les données initiales (version CASH)
 * - Pas d’appel Stripe client
 * - On récupère juste la speculated transaction pour afficher le breakdown
 */
export const loadInitialDataForCashPayments = ({
  pageData,
  fetchSpeculatedTransaction,
  config,
}) => {
  const shippingDetails = {};
  const optionalPaymentParams = {};
  const orderParams = getOrderParams(pageData, shippingDetails, optionalPaymentParams, config);

  fetchSpeculatedTransactionIfNeeded(orderParams, pageData, fetchSpeculatedTransaction);
};

// -----------------------------
// Page component (même structure que CheckoutPageWithPayment)
// -----------------------------

const CheckoutCashPage = props => {
  const [submitting, setSubmitting] = useState(false);

  const {
    scrollingDisabled,
    speculateTransactionError,
    speculatedTransaction: speculatedTransactionMaybe,
    isClockInSync, // utile pour l’état de paiement pending (qu’on n’utilise pas ici mais garde la signature)
    initiateOrderError,
    intl,
    currentUser,
    showListingImage,
    pageData,
    processName,
    listingTitle,
    title,
    config,
    routeConfiguration,
    history,
    onInitiateOrder,
    onSubmitCallback,
  } = props;

  const listingNotFound =
    isTransactionInitiateListingNotFoundError(speculateTransactionError) ||
    isTransactionInitiateListingNotFoundError(initiateOrderError);

  const { listing, transaction, orderData } = pageData;
  const existingTransaction = ensureTransaction(transaction);
  const speculatedTransaction = ensureTransaction(speculatedTransactionMaybe, {}, null);

  const tx =
    existingTransaction?.attributes?.lineItems?.length > 0
      ? existingTransaction
      : speculatedTransaction;

  const timeZone = listing?.attributes?.availabilityPlan?.timezone;
  const transactionProcessAlias = listing?.attributes?.publicData?.transactionProcessAlias;
  const priceVariantName = tx.attributes.protectedData?.priceVariantName;
  const txBookingMaybe = tx?.booking?.id ? { booking: tx.booking, timeZone } : {};

  const breakdown =
    tx.id && tx.attributes.lineItems?.length > 0 ? (
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

  const process = processName ? getProcess(processName) : null;
  const transitions = process?.transitions || {};

  const firstImage = listing?.images?.length > 0 ? listing.images[0] : null;

  const listingLink = (
    <NamedLink
      name="ListingPage"
      params={{ id: listing?.id?.uuid, slug: createSlug(listingTitle) }}
    >
      <FormattedMessage id="CheckoutPage.errorlistingLinkText" />
    </NamedLink>
  );

  // On réutilise le même helper d’erreurs (certains messages seront simplement absents)
  const errorMessages = getErrorMessages(
    listingNotFound,
    initiateOrderError,
    false,               // isPaymentExpired (pas pertinent pour cash)
    null,                // retrievePaymentIntentError
    speculateTransactionError,
    listingLink
  );

  const showInitialMessageInput = true; // pas d'INQUIRE imposé ici

  const askShippingDetails = orderData?.deliveryMethod === 'shipping';

  const handleCashSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);

    try {
      const shippingDetails = getShippingDetailsMaybe({}); // pas de formulaire ici
      const optionalPaymentParams = {}; // rien côté Stripe
      const orderParams = getOrderParams(pageData, shippingDetails, optionalPaymentParams, config);

      // Même logique que la page paiement carte pour déterminer la transition
      const isInquiryInPaymentProcess =
        existingTransaction?.attributes?.lastTransition === transitions.INQUIRE;
      const requestTransition = isInquiryInPaymentProcess
        ? transitions.REQUEST_PAYMENT_AFTER_INQUIRY
        : transitions.REQUEST_PAYMENT;
      const isPrivileged = process && requestTransition ? process.isPrivileged(requestTransition) : false;

      const transactionId = existingTransaction?.id || null;

      const response = await onInitiateOrder(
        orderParams,
        transactionProcessAlias,
        transactionId,
        requestTransition,
        isPrivileged
      );

      const orderId =
        response?.orderId ||
        response?.data?.id ||
        response?.data?.id?.uuid ||
        response?.id ||
        response?.uuid ||
        null;

      if (orderId) {
        const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, {
          id: orderId.uuid ? orderId.uuid : orderId,
        });
        onSubmitCallback && onSubmitCallback();
        history.push(orderDetailsPath);
      } else {
        // fallback : retour à la fiche
        onSubmitCallback && onSubmitCallback();
        history.push(`/l/${createSlug(listingTitle)}/${listing.id.uuid}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('CheckoutCashPage submit error', err);
      setSubmitting(false);
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
              <FormattedMessage id="CheckoutPage.listingTitle" values={{ listingTitle }} />
            </H4>
          </div>

          <MobileOrderBreakdown
            speculateTransactionErrorMessage={errorMessages.speculateTransactionErrorMessage}
            breakdown={breakdown}
            priceVariantName={priceVariantName}
          />

          <section className={css.paymentContainer}>
            {/* Erreurs éventuelles */}
            {errorMessages.initiateOrderErrorMessage}
            {errorMessages.listingNotFoundErrorMessage}
            {errorMessages.speculateErrorMessage}

            {/* Bloc "paiement en espèces" */}
            <div className={css.cashBox}>
              <p><FormattedMessage id="CheckoutPage.payInCash.instruction" /></p>
              {totalPrice ? (
                <p className={css.totalPrice}>
                  <strong>
                    <FormattedMessage id="CheckoutPage.totalPrice" values={{ totalPrice }} />
                  </strong>
                </p>
              ) : null}

              <div className={css.confirmRow}>
                <Button
                  className={css.primaryButton}
                  onClick={handleCashSubmit}
                  disabled={submitting}
                  type="button"
                >
                  {submitting ? (
                    <FormattedMessage id="CheckoutPage.confirming" />
                  ) : (
                    <FormattedMessage id="CheckoutPage.payInCash.confirmButton" />
                  )}
                </Button>
              </div>
            </div>
          </section>
        </div>

        <DetailsSideCard
          listing={listing}
          listingTitle={listingTitle}
          priceVariantName={priceVariantName}
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

CheckoutCashPage.defaultProps = { showListingImage: true };
CheckoutCashPage.propTypes = {
  scrollingDisabled: propTypes.bool,
  speculateTransactionError: propTypes.string,
  speculatedTransaction: propTypes.transaction,
  isClockInSync: propTypes.bool,
  initiateOrderError: propTypes.string,
  intl: propTypes.intl.isRequired,
  currentUser: propTypes.currentUser,
  showListingImage: propTypes.bool,
  pageData: propTypes.object.isRequired,
  processName: propTypes.string,
  listingTitle: propTypes.string,
  title: propTypes.string,
  config: propTypes.object.isRequired,
  routeConfiguration: propTypes.object.isRequired,
  history: propTypes.object.isRequired,
  onInitiateOrder: propTypes.func.isRequired,
  onSubmitCallback: propTypes.func.isRequired,
};

export default CheckoutCashPage;
