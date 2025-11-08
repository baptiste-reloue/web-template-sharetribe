import React, { useState } from 'react';
import { useHistory } from 'react-router-dom';
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { createSlug } from '../../util/urlHelpers';
import { getProcess } from '../../transactions/transaction';
import { ensureTransaction } from '../../util/data';
import { H3, H4, Page, Button, NamedLink } from '../../components';

import CustomTopbar from '../CheckoutPage/CustomTopbar';
import DetailsSideCard from '../CheckoutPage/DetailsSideCard';
import MobileListingImage from '../CheckoutPage/MobileListingImage';
import MobileOrderBreakdown from '../CheckoutPage/MobileOrderBreakdown';
import OrderBreakdown from '../../components/OrderBreakdown/OrderBreakdown';

import {
  bookingDatesMaybe,
  getBillingDetails,
  getFormattedTotalPrice,
  getShippingDetailsMaybe,
  getTransactionTypeData,
} from '../CheckoutPage/CheckoutPageTransactionHelpers.js';

import css from '../CheckoutPage/CheckoutPage.module.css';

/**
 * Construire orderParams (version minimale reprise du code de CheckoutPageWithPayment)
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
  const priceVariantMaybe = priceVariant
    ? Object.fromEntries(
        Object.entries(priceVariant).map(([key, value]) => [`priceVariant${key.charAt(0).toUpperCase()}${key.slice(1)}`, value])
      )
    : {};

  const protectedDataMaybe = {
    protectedData: {
      ...getTransactionTypeData(listingType, unitType, config),
      ...deliveryMethodMaybe,
      ...shippingDetails,
      ...priceVariantMaybe,
    },
  };

  const orderParams = {
    listingId: pageData?.listing?.id,
    ...deliveryMethodMaybe,
    ...quantityMaybe,
    ...seatsMaybe,
    ...bookingDatesMaybe(pageData.orderData?.bookingDates),
    ...priceVariantNameMaybe,
    ...protectedDataMaybe,
    ...optionalPaymentParams,
  };

  return orderParams;
};

const CheckoutCashPage = props => {
  const {
    pageData,
    config,
    intl,
    history: historyProp,
    onInitiateOrder,
    onSubmitCallback,
    speculateTransactionInProgress,
    showListingImage,
  } = props;

  const history = useHistory() || historyProp;
  const [submitting, setSubmitting] = useState(false);

  const { listing, transaction } = pageData || {};
  const existingTransaction = ensureTransaction(transaction);
  const tx = existingTransaction;
  const listingTitle = listing?.attributes?.title;
  const title = intl.formatMessage(
    { id: 'CheckoutPage.reloue-booking-cash.title' },
    { listingTitle, authorDisplayName: listing?.author?.attributes?.profile?.displayName || '' }
  );

  const processName = 'reloue-booking-cash';
  const process = getProcess(processName);
  const transactionProcessAlias = listing?.attributes?.publicData?.transactionProcessAlias;

  // Build breakdown using existing or speculated transaction (if any)
  const breakdown =
    tx?.id && tx.attributes.lineItems?.length > 0 ? (
      <OrderBreakdown
        className={css.orderBreakdown}
        userRole="customer"
        transaction={tx}
        currency={config.currency}
        marketplaceName={config.marketplaceName}
      />
    ) : null;

  const totalPrice = tx?.attributes?.lineItems?.length > 0 ? getFormattedTotalPrice(tx, intl) : null;

  // Determine correct transition to call for initiation (mirrors CheckoutPageWithPayment logic)
  const transitions = process?.transitions || {};
  const isInquiryInPaymentProcess = tx?.attributes?.lastTransition === transitions.INQUIRE;
  const requestTransition = isInquiryInPaymentProcess
    ? transitions.REQUEST_PAYMENT_AFTER_INQUIRY
    : transitions.REQUEST_PAYMENT;
  const isPrivileged = process && requestTransition ? process.isPrivileged(requestTransition) : false;

  const handleCashSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);

    try {
      const shippingDetails = getShippingDetailsMaybe({}); // no shipping by default, but keep helper
      const optionalPaymentParams = {}; // no stripe params for cash
      const orderParams = getOrderParams(pageData, shippingDetails, optionalPaymentParams, config);

      // onInitiateOrder signature: (params, processAlias, transactionId, transitionName, isPrivileged)
      const processAlias = transactionProcessAlias;
      const transactionId = tx?.id || null;

      const response = await onInitiateOrder(
        orderParams,
        processAlias,
        transactionId,
        requestTransition,
        isPrivileged
      );

      // Try to obtain an orderId to navigate to OrderDetailsPage like in other flows.
      // The duck might return the created order id in different shapes; attempt common ones.
      const orderId =
        (response && response.orderId) ||
        (response && response.data && response.data.id) ||
        (response && response.data && response.data.id && response.data.id.uuid) ||
        (response && response.id) ||
        (response && response.uuid) ||
        null;

      // If we can build a route to the OrderDetailsPage
      if (orderId) {
        // If orderId is an object with uuid
        const idUuid = orderId.uuid ? orderId.uuid : orderId;
        const orderDetailsPath = pathByRouteName('OrderDetailsPage', config.routeConfiguration || {}, {
          id: idUuid,
        });
        onSubmitCallback && onSubmitCallback();
        history.push(orderDetailsPath);
      } else {
        // Fallback: redirect to listing or show a simple confirmation page
        onSubmitCallback && onSubmitCallback();
        history.push(`/l/${createSlug(listingTitle)}/${listing.id.uuid}`);
      }
    } catch (err) {
      console.error('CheckoutCashPage: error initiating cash order', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Page title={title} scrollingDisabled={false}>
      <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
      <div className={css.contentContainer}>
        <MobileListingImage
          listingTitle={listingTitle}
          author={listing?.author}
          firstImage={listing?.images?.length > 0 ? listing.images[0] : null}
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

          <MobileOrderBreakdown breakdown={breakdown} priceVariantName={tx?.attributes?.protectedData?.priceVariantName} />

          <section className={css.paymentContainer}>
            <div className={css.cashNotice}>
              <p>
                <FormattedMessage id="CheckoutPage.payInCash.instruction" />
              </p>
              <p className={css.totalPrice}>
                {totalPrice ? (
                  <strong>
                    <FormattedMessage id="CheckoutPage.totalPrice" values={{ totalPrice }} />
                  </strong>
                ) : null}
              </p>
            </div>

            <div className={css.confirmRow}>
              <Button
                className={css.primaryButton}
                onClick={handleCashSubmit}
                disabled={submitting || speculateTransactionInProgress}
              >
                {submitting ? (
                  <FormattedMessage id="CheckoutPage.confirming" />
                ) : (
                  <FormattedMessage id="CheckoutPage.payInCash.confirmButton" />
                )}
              </Button>
            </div>

            <div className={css.backLinkRow}>
              <NamedLink name="ListingPage" params={{ id: listing?.id?.uuid, slug: createSlug(listingTitle) }}>
                ← <FormattedMessage id="CheckoutPage.backToListing" />
              </NamedLink>
            </div>
          </section>
        </div>

        <DetailsSideCard
          listing={listing}
          listingTitle={listingTitle}
          author={listing?.author}
          firstImage={listing?.images?.length > 0 ? listing.images[0] : null}
          layoutListingImageConfig={config.layout.listingImage}
          breakdown={breakdown}
          showListingImage={showListingImage}
          intl={intl}
        />
      </div>
    </Page>
  );
};

export default CheckoutCashPage;
