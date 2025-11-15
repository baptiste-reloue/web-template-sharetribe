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

// ---------- helpers (copiés de la page carte) ----------
const cap = s => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const prefixPriceVariantProperties = priceVariant => {
  if (!priceVariant) return {};
  return Object.fromEntries(
    Object.entries(priceVariant).map(([k, v]) => [`priceVariant${cap(k)}`, v])
  );
};

// Construit orderParams (identique à la carte, mais sans params Stripe + flag de méthode)
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
      paymentMethod: 'cash', // simple marqueur back
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

// ---------- préchargement (speculated transaction) ----------
export const loadInitialDataForCashPayments = ({ pageData, fetchSpeculatedTransaction, config }) => {
  const tx = pageData?.transaction || null;
  const listing = pageData?.listing;
  const discoveredProcessName =
    tx?.attributes?.processName ||
    listing?.attributes?.publicData?.transactionProcessAlias?.split('/')[0] ||
    null;

  const process = discoveredProcessName ? getProcess(discoveredProcessName) : null;
  const shouldFetchSpeculated =
    !!pageData?.listing?.id &&
    !!pageData?.orderData &&
    !!process &&
    !hasTransactionPassedPendingPayment(tx, process);

  if (!shouldFetchSpeculated) return;

  const orderParams = getOrderParams(pageData, {}, {}, config);
  const transactionId = tx ? tx.id : null;

  // transitions robustes: fallback en texte si nécessaire
  const transitions = process?.transitions || {};
  const isInquiry = tx?.attributes?.lastTransition === transitions?.INQUIRE;
  const requestTransition = isInquiry
    ? transitions?.REQUEST_PAYMENT_AFTER_INQUIRY || 'transition/request-payment-after-inquiry'
    : transitions?.REQUEST_PAYMENT || 'transition/request-payment';
  const isPrivileged = process && transitions && requestTransition
    ? !!process.isPrivileged?.(requestTransition)
    : false;

  fetchSpeculatedTransaction(
    orderParams,
    'reloue-booking-cash/release-1',
    transactionId,
    requestTransition,
    isPrivileged
  );
};

// ---------- page (même squelette que CheckoutPageWithPayment, sans Stripe) ----------
const CheckoutCashPage = props => {
  const [submitting, setSubmitting] = useState(false);

  const {
    scrollingDisabled,
    speculateTransactionError,
    speculatedTransaction: speculatedTransactionMaybe,
    initiateOrderError,
    intl,
    showListingImage,
    pageData,
    processName,          // "reloue-booking-cash" (fourni par CheckoutPage)
    listingTitle,
    title,
    config,
    routeConfiguration,
    history,
    onInitiateOrder,
    onSubmitCallback,
  } = props;

  const process = processName ? getProcess(processName) : null;
  const transitions = process?.transitions || {};
  const processAlias = 'reloue-booking-cash/release-1';

  const listingNotFound =
    isTransactionInitiateListingNotFoundError(speculateTransactionError) ||
    isTransactionInitiateListingNotFoundError(initiateOrderError);

  const { listing, transaction } = pageData || {};
  const existingTransaction = ensureTransaction(transaction);
  const speculatedTransaction = ensureTransaction(speculatedTransactionMaybe, {}, null);

  // tx = existante (avec lineItems) sinon speculée
  const tx =
    existingTransaction?.attributes?.lineItems?.length > 0
      ? existingTransaction
      : speculatedTransaction;

  const timeZone = listing?.attributes?.availabilityPlan?.timezone;
  const transactionProcessAlias = listing?.attributes?.publicData?.transactionProcessAlias;
  const priceVariantName = tx?.attributes?.protectedData?.priceVariantName;
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

  const totalPrice = tx?.attributes?.lineItems?.length > 0 ? getFormattedTotalPrice(tx, intl) : null;

  const firstImage = listing?.images?.[0] || null;

  const listingLink = (
    <NamedLink
      name="ListingPage"
      params={{ id: listing?.id?.uuid, slug: createSlug(listingTitle) }}
    >
      <FormattedMessage id="CheckoutPage.errorlistingLinkText" />
    </NamedLink>
  );

  const errorMessages = getErrorMessages(
    listingNotFound,
    initiateOrderError,
    false,                 // isPaymentExpired (non pertinent en cash)
    null,                  // retrievePaymentIntentError (pas de Stripe)
    speculateTransactionError,
    listingLink
  );

  const handleCashSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);

    try {
      const shippingDetails = getShippingDetailsMaybe({});
      const orderParams = getOrderParams(pageData, shippingDetails, {}, config);

      // transitions robustes avec fallback
      const isInquiry = existingTransaction?.attributes?.lastTransition === transitions?.INQUIRE;
      const requestTransition = isInquiry
        ? transitions?.REQUEST_PAYMENT_AFTER_INQUIRY || 'transition/request-payment-after-inquiry'
        : transitions?.REQUEST_PAYMENT || 'transition/request-payment';
      const isPrivileged = process && transitions && requestTransition
        ? !!process.isPrivileged?.(requestTransition)
        : false;

      const transactionId = existingTransaction?.id || null;

      const res = await onInitiateOrder(
        orderParams,
        processAlias,
        transactionId,
        requestTransition,
        isPrivileged
      );

      const orderId =
        res?.orderId || res?.data?.id || res?.data?.id?.uuid || res?.id || res?.uuid || null;

      if (orderId) {
        const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, {
          id: orderId.uuid ? orderId.uuid : orderId,
        });
        onSubmitCallback && onSubmitCallback();
        history.push(orderDetailsPath);
      } else {
        onSubmitCallback && onSubmitCallback();
        history.push(`/l/${createSlug(listingTitle)}/${listing.id.uuid}`);
      }
    } catch (e) {
      console.error('CheckoutCashPage error', e);
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
            {errorMessages.initiateOrderErrorMessage}
            {errorMessages.listingNotFoundErrorMessage}
            {errorMessages.speculateErrorMessage}

            {/* Bloc cash à la place du StripePaymentForm */}
            <div className={css.cashBox}>
              <p><FormattedMessage id="CheckoutPage.payInCash.instruction" /></p>
              {totalPrice ? (
                <p className={css.totalPrice}>
                  <strong><FormattedMessage id="CheckoutPage.totalPrice" values={{ totalPrice }} /></strong>
                </p>
              ) : null}

              <div className={css.confirmRow}>
                <Button
                  className={css.primaryButton}
                  onClick={handleCashSubmit}
                  disabled={submitting}
                  type="button"
                >
                  {submitting
                    ? <FormattedMessage id="CheckoutPage.confirming" />
                    : <FormattedMessage id="CheckoutPage.payInCash.confirmButton" />}
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
  initiateOrderError: propTypes.string,
  intl: propTypes.intl.isRequired,
  showListingImage: propTypes.bool,
  pageData: propTypes.object.isRequired,
  processName: propTypes.string, // "reloue-booking-cash"
  listingTitle: propTypes.string,
  title: propTypes.string,
  config: propTypes.object.isRequired,
  routeConfiguration: propTypes.object.isRequired,
  history: propTypes.object.isRequired,
  onInitiateOrder: propTypes.func.isRequired,
  onSubmitCallback: propTypes.func.isRequired,
};

export default CheckoutCashPage;
