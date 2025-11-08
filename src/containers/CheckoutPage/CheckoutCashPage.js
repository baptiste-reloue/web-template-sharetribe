import React, { useState } from 'react';

// Contexts & utils
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { propTypes } from '../../util/types';
import { ensureTransaction } from '../../util/data';
import { createSlug } from '../../util/urlHelpers';
import { isTransactionInitiateListingNotFoundError } from '../../util/errors';
import { getProcess } from '../../transactions/transaction';

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

// ---------- helpers identiques à la page carte ----------
const cap = s => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const prefixPriceVariantProperties = pv =>
  pv ? Object.fromEntries(Object.entries(pv).map(([k, v]) => [`priceVariant${cap(k)}`, v])) : {};

const buildOrderParams = (pageData, config) => {
  const quantity = pageData.orderData?.quantity;
  const seats = pageData.orderData?.seats;
  const deliveryMethod = pageData.orderData?.deliveryMethod;

  const { listingType, unitType, priceVariants } = pageData?.listing?.attributes?.publicData || {};
  const priceVariantName = pageData.orderData?.priceVariantName;
  const priceVariant = priceVariants?.find(pv => pv.name === priceVariantName);

  const protectedData = {
    ...getTransactionTypeData(listingType, unitType, config),
    ...(deliveryMethod ? { deliveryMethod } : {}),
    ...prefixPriceVariantProperties(priceVariant),
    paymentMethod: 'cash', // simple marqueur côté back
  };

  return {
    listingId: pageData?.listing?.id,
    ...(deliveryMethod ? { deliveryMethod } : {}),
    ...(quantity ? { quantity } : {}),
    ...(seats ? { seats } : {}),
    ...bookingDatesMaybe(pageData.orderData?.bookingDates),
    ...(priceVariantName ? { priceVariantName } : {}),
    protectedData,
    ...getShippingDetailsMaybe({}),
  };
};

// ---------- préchargement (speculated transaction) ----------
export const loadInitialDataForCashPayments = ({ pageData, fetchSpeculatedTransaction, config }) => {
  const tx = pageData?.transaction;
  const listing = pageData?.listing;
  const processName =
    tx?.attributes?.processName ||
    listing?.attributes?.publicData?.transactionProcessAlias?.split('/')[0];

  const process = processName ? getProcess(processName) : null;
  if (!pageData?.listing?.id || !pageData?.orderData || !process) return;

  if (!hasTransactionPassedPendingPayment(tx, process)) {
    const orderParams = buildOrderParams(pageData, config);
    const processAlias = 'reloue-booking-cash';
    const transactionId = tx ? tx.id : null;
    const isInquiryInPaymentProcess = tx?.attributes?.lastTransition === process.transitions.INQUIRE;
    const requestTransition = isInquiryInPaymentProcess
      ? process.transitions.REQUEST_PAYMENT_AFTER_INQUIRY
      : process.transitions.REQUEST_PAYMENT;
    const isPrivileged = process.isPrivileged(requestTransition);

    fetchSpeculatedTransaction(orderParams, processAlias, transactionId, requestTransition, isPrivileged);
  }
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
    processName,          // transmis par CheckoutPage: "reloue-booking-cash"
    listingTitle,
    title,
    config,
    routeConfiguration,
    history,
    onInitiateOrder,
    onSubmitCallback,
  } = props;

  // process & alias cash (on force l’alias cash)
  const process = processName ? getProcess(processName) : null;
  const processAlias = 'reloue-booking-cash/release-1';

  const listingNotFound =
    isTransactionInitiateListingNotFoundError(speculateTransactionError) ||
    isTransactionInitiateListingNotFoundError(initiateOrderError);

  const { listing, transaction } = pageData || {};
  const existingTx = ensureTransaction(transaction);
  const speculatedTx = ensureTransaction(speculatedTransactionMaybe, {}, null);

  const tx = existingTx?.attributes?.lineItems?.length > 0 ? existingTx : speculatedTx;

  const timeZone = listing?.attributes?.availabilityPlan?.timezone;
  const priceVariantName = tx.attributes?.protectedData?.priceVariantName;
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

  const totalPrice = tx?.attributes?.lineItems?.length > 0 ? getFormattedTotalPrice(tx, intl) : null;
  const transitions = process?.transitions || {};
  const firstImage = listing?.images?.[0] || null;

  const listingLink = (
    <NamedLink name="ListingPage" params={{ id: listing?.id?.uuid, slug: createSlug(listingTitle) }}>
      <FormattedMessage id="CheckoutPage.errorlistingLinkText" />
    </NamedLink>
  );

  const errorMessages = getErrorMessages(
    listingNotFound,
    initiateOrderError,
    false, // expired (non concerné en cash)
    null,  // retrievePaymentIntentError (n’existe pas ici)
    speculateTransactionError,
    listingLink
  );

  const handleCashSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const orderParams = buildOrderParams(pageData, config);

      // même logique de transition que la page carte
      const isInquiry = existingTx?.attributes?.lastTransition === transitions.INQUIRE;
      const requestTransition = isInquiry
        ? transitions.REQUEST_PAYMENT_AFTER_INQUIRY
        : transitions.REQUEST_PAYMENT;
      const isPrivileged = process && requestTransition ? process.isPrivileged(requestTransition) : false;

      const transactionId = existingTx?.id || null;

      const res = await onInitiateOrder(
        orderParams,
        processAlias,      // <— on force le process CASH
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
            <H3 as="h1" className={css.heading}>{title}</H3>
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

            {/* Bloc cash minimaliste (à la place du StripePaymentForm) */}
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
