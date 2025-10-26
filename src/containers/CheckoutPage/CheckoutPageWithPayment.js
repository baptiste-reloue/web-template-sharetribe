// src/containers/CheckoutPage/CheckoutPageWithPayment.js

import React, { useState } from 'react';
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { propTypes } from '../../util/types';
import { ensureTransaction } from '../../util/data';
import { createSlug } from '../../util/urlHelpers';
import { isTransactionInitiateListingNotFoundError } from '../../util/errors';
import { getProcess, isBookingProcessAlias } from '../../transactions/transaction';

import { H3, H4, NamedLink, OrderBreakdown, Page } from '../../components';

import {
  getFormattedTotalPrice,
  getOrderParams,
  hasDefaultPaymentMethod,
  hasPaymentExpired,
  hasTransactionPassedPendingPayment,
  processCheckoutWithPayment,
} from './CheckoutPageTransactionHelpers.js';
import { getErrorMessages } from './ErrorMessages';

import CustomTopbar from './CustomTopbar';
import StripePaymentForm from './StripePaymentForm/StripePaymentForm';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import css from './CheckoutPage.module.css';

const CheckoutPageWithPayment = props => {
  const [submitting, setSubmitting] = useState(false);
  const [stripeInstance, setStripeInstance] = useState(null);

  const {
    scrollingDisabled,
    speculateTransactionError,
    speculatedTransaction: speculatedTransactionMaybe,
    isClockInSync,
    initiateOrderError,
    confirmPaymentError,
    intl,
    currentUser,
    confirmCardPaymentError,
    showListingImage,
    paymentIntent,
    retrievePaymentIntentError,
    stripeCustomerFetched,
    pageData,
    processName,
    listingTitle,
    title,
    config,
    history,
    routeConfiguration,

    // thunks / actions
    onInitiateCashOrder,
    onInitiateOrder,
    onConfirmCardPayment,
    onConfirmPayment,
    onSendMessage,
    onSavePaymentMethod,

    onSubmitCallback,
    sessionStorageKey,
    setPageData,
  } = props;

  // --- Data extraction ---
  const listing = pageData?.listing;
  const orderData = pageData?.orderData || {};
  const chosenPaymentMethod = orderData?.paymentMethod || 'card';

  const existingTransaction = ensureTransaction(pageData?.transaction);
  const speculatedTransaction = ensureTransaction(speculatedTransactionMaybe, {}, null);

  // choose tx (existing with full lineItems > speculated)
  const tx =
    existingTransaction?.attributes?.lineItems?.length > 0
      ? existingTransaction
      : speculatedTransaction;

  const timeZone = listing?.attributes?.availabilityPlan?.timezone;
  const transactionProcessAlias = listing?.attributes?.publicData?.transactionProcessAlias;
  const priceVariantName = tx?.attributes?.protectedData?.priceVariantName;

  const txBookingMaybe = tx?.booking?.id
    ? { booking: tx.booking, timeZone }
    : {};

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
    tx?.attributes?.lineItems?.length > 0
      ? getFormattedTotalPrice(tx, intl)
      : null;

  const process = processName ? getProcess(processName) : null;
  const isPaymentExpired = hasPaymentExpired(
    existingTransaction,
    process,
    isClockInSync
  );

  const listingNotFound =
    isTransactionInitiateListingNotFoundError(speculateTransactionError) ||
    isTransactionInitiateListingNotFoundError(initiateOrderError);

  const errorMessages = getErrorMessages(
    listingNotFound,
    initiateOrderError,
    isPaymentExpired,
    retrievePaymentIntentError,
    speculateTransactionError,
    <NamedLink
      name="ListingPage"
      params={{
        id: listing?.id?.uuid,
        slug: createSlug(listingTitle),
      }}
    >
      <FormattedMessage id="CheckoutPage.errorlistingLinkText" />
    </NamedLink>
  );

  // transactionId si déjà existante
  const transactionId = existingTransaction?.id || null;

  // ------------------------------------------------------------------
  // Helpers to prepare params
  // ------------------------------------------------------------------
  const buildOrderParams = optionalPaymentParams => {
    // On ne gère pas ici de shippingDetails custom => vide
    const shippingDetails = {};
    return getOrderParams(
      pageData,
      shippingDetails,
      optionalPaymentParams,
      config
    );
  };

  // ------------------------------------------------------------------
  // CASH FLOW: no Stripe at all
  // ------------------------------------------------------------------
  const handleCashSubmit = () => {
    if (submitting) return;
    setSubmitting(true);

    const orderParams = buildOrderParams({}); // pas de stripe params

    onInitiateCashOrder(orderParams, transactionId)
      .then(response => {
        // Clear checkout session data
        onSubmitCallback();

        // Extraire l'ID de la transaction créée pour redirection OrderDetails
        let orderId = null;

        // Plusieurs patterns possibles selon comment ton duck/SDK renvoie :
        // 1) response.data.data.id
        if (
          response &&
          response.data &&
          response.data.data &&
          response.data.data.id
        ) {
          orderId = response.data.data.id;
        }

        // 2) response.payload.data.data.id
        if (
          !orderId &&
          response &&
          response.payload &&
          response.payload.data &&
          response.payload.data.data &&
          response.payload.data.data.id
        ) {
          orderId = response.payload.data.data.id;
        }

        // Redirection
        if (orderId) {
          const orderDetailsPath = pathByRouteName(
            'OrderDetailsPage',
            routeConfiguration,
            { id: orderId }
          );
          history.push(orderDetailsPath);
        } else {
          // fallback => ListingPage
          history.push(
            pathByRouteName('ListingPage', routeConfiguration, {
              id: listing?.id?.uuid,
            })
          );
        }

        setSubmitting(false);
      })
      .catch(err => {
        console.error('Failed to initiate cash order', err);
        setSubmitting(false);
      });
  };

  // ------------------------------------------------------------------
  // CARD / STRIPE FLOW
  // ------------------------------------------------------------------
  const handleCardSubmit = values => {
    if (submitting) return;
    setSubmitting(true);

    // processCheckoutWithPayment encapsule :
    // - initiateOrder (avec processAlias booking Stripe)
    // - confirmCardPayment (Stripe)
    // - confirmPayment transition
    // - envoi du premier message
    //
    // On lui file toutes les dépendances dont il a besoin.
    const optionalPaymentParams = {
      // Ces valeurs viennent du formulaire StripePaymentForm (titulaire, message initial...)
      message: values?.message,
      setupPaymentMethod: values?.setupPaymentMethod,
      paymentIntentId: paymentIntent?.id,
      paymentMethodId: values?.paymentMethodId,
      stripePaymentMethodId: values?.stripePaymentMethodId,
      card: values?.card,
      stripe: stripeInstance,
    };

    const orderParams = buildOrderParams(optionalPaymentParams);

    processCheckoutWithPayment({
      orderParams,
      pageData,
      transactionId,
      stripeCustomerFetched,
      stripeCustomer: currentUser?.stripeCustomer,
      hasDefaultPaymentMethod: hasDefaultPaymentMethod(
        stripeCustomerFetched,
        currentUser
      ),
      hasTransactionPassedPendingPayment: hasTransactionPassedPendingPayment(
        existingTransaction,
        process
      ),
      onInitiateOrder,
      onConfirmCardPayment,
      onConfirmPayment,
      onSendMessage,
      onSavePaymentMethod,
      paymentIntent,
      processName,
    })
      .then(orderId => {
        onSubmitCallback();

        const orderDetailsPath = pathByRouteName(
          'OrderDetailsPage',
          routeConfiguration,
          { id: orderId }
        );
        history.push(orderDetailsPath);
        setSubmitting(false);
      })
      .catch(e => {
        console.error('Card payment flow failed', e);
        setSubmitting(false);
      });
  };

  // ------------------------------------------------------------------
  // View-level conditions
  // ------------------------------------------------------------------
  const showPaymentSection =
    currentUser &&
    !listingNotFound &&
    !initiateOrderError &&
    !speculateTransactionError &&
    !retrievePaymentIntentError &&
    !isPaymentExpired;

  const firstImage =
    listing?.images && listing.images.length > 0 ? listing.images[0] : null;

  return (
    <Page title={title} scrollingDisabled={scrollingDisabled}>
      <CustomTopbar
        intl={intl}
        linkToExternalSite={config?.topbar?.logoLink}
      />
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
              <FormattedMessage
                id="CheckoutPage.listingTitle"
                values={{ listingTitle }}
              />
            </H4>
          </div>

          <MobileOrderBreakdown
            speculateTransactionErrorMessage={
              errorMessages.speculateTransactionErrorMessage
            }
            breakdown={breakdown}
            priceVariantName={priceVariantName}
          />

          <section className={css.paymentContainer}>
            {errorMessages.initiateOrderErrorMessage}
            {errorMessages.listingNotFoundErrorMessage}
            {errorMessages.speculateErrorMessage}
            {errorMessages.retrievePaymentIntentErrorMessage}
            {errorMessages.paymentExpiredMessage}

            {/* MODE CARTE (STRIPE) */}
            {chosenPaymentMethod === 'card' ? (
              showPaymentSection ? (
                <StripePaymentForm
                  className={css.paymentForm}
                  onSubmit={handleCardSubmit}
                  inProgress={submitting}
                  formId="CheckoutPagePaymentForm"
                  authorDisplayName={
                    listing?.author?.attributes?.profile?.displayName
                  }
                  showInitialMessageInput={true}
                  initialValues={{}}
                  initiateOrderError={initiateOrderError}
                  confirmCardPaymentError={confirmCardPaymentError}
                  confirmPaymentError={confirmPaymentError}
                  hasHandledCardPayment={false}
                  loadingData={!stripeCustomerFetched}
                  defaultPaymentMethod={
                    hasDefaultPaymentMethod(
                      stripeCustomerFetched,
                      currentUser
                    )
                      ? currentUser.stripeCustomer.defaultPaymentMethod
                      : null
                  }
                  paymentIntent={paymentIntent}
                  onStripeInitialized={stripe => {
                    setStripeInstance(stripe);
                    return;
                  }}
                  askShippingDetails={
                    orderData?.deliveryMethod === 'shipping'
                  }
                  showPickUplocation={
                    orderData?.deliveryMethod === 'pickup'
                  }
                  listingLocation={
                    listing?.attributes?.publicData?.location
                  }
                  totalPrice={totalPrice}
                  locale={config.localization.locale}
                  stripePublishableKey={
                    config.stripe.publishableKey
                  }
                  marketplaceName={config.marketplaceName}
                  isBooking={isBookingProcessAlias(
                    transactionProcessAlias
                  )}
                  isFuzzyLocation={config.maps.fuzzy.enabled}
                />
              ) : null
            ) : (
              // MODE CASH
              <>
                <div className={css.fieldInquiryMessage}>
                  <p>
                    <FormattedMessage
                      id="CheckoutPage.cashNotice"
                      defaultMessage="Vous avez choisi de payer en espèces lors de la remise. Aucune carte ne sera demandée maintenant. En envoyant la demande, les dates seront réservées jusqu'à la réponse du propriétaire."
                    />
                  </p>
                </div>

                <div style={{ marginTop: 16 }}>
                  <button
                    className="button"
                    disabled={submitting}
                    onClick={handleCashSubmit}
                  >
                    {submitting ? (
                      <FormattedMessage
                        id="CheckoutPage.sending"
                        defaultMessage="Envoi..."
                      />
                    ) : (
                      <FormattedMessage
                        id="CheckoutPage.sendRequest"
                        defaultMessage="Envoyer la demande"
                      />
                    )}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>

        <DetailsSideCard
          listing={listing}
          listingTitle={listingTitle}
          priceVariantName={priceVariantName}
          author={listing?.author}
          firstImage={firstImage}
          layoutListingImageConfig={config.layout.listingImage}
          speculateTransactionErrorMessage={
            errorMessages.speculateTransactionErrorMessage
          }
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

CheckoutPageWithPayment.defaultProps = {
  speculatedTransaction: null,
  pageData: null,
  processName: null,
  listingTitle: null,
  title: null,
  currentUser: null,
  stripeCustomerFetched: null,
  paymentIntent: null,
};

CheckoutPageWithPayment.propTypes = {
  scrollingDisabled: propTypes.bool.isRequired,
  speculateTransactionError: propTypes.error,
  speculatedTransaction: propTypes.tx,
  isClockInSync: propTypes.bool,
  initiateOrderError: propTypes.error,
  confirmPaymentError: propTypes.error,
  intl: propTypes.any.isRequired,
  currentUser: propTypes.currentUser,
  confirmCardPaymentError: propTypes.error,
  showListingImage: propTypes.bool.isRequired,
  paymentIntent: propTypes.object,
  retrievePaymentIntentError: propTypes.error,
  stripeCustomerFetched: propTypes.object,
  pageData: propTypes.object,
  processName: propTypes.string,
  listingTitle: propTypes.string,
  title: propTypes.string,
  config: propTypes.object.isRequired,
  history: propTypes.object.isRequired,
  routeConfiguration: propTypes.array.isRequired,
  onInitiateCashOrder: propTypes.func.isRequired,
  onInitiateOrder: propTypes.func.isRequired,
  onConfirmCardPayment: propTypes.func.isRequired,
  onConfirmPayment: propTypes.func.isRequired,
  onSendMessage: propTypes.func.isRequired,
  onSavePaymentMethod: propTypes.func.isRequired,
  onSubmitCallback: propTypes.func.isRequired,
  sessionStorageKey: propTypes.string.isRequired,
  setPageData: propTypes.func.isRequired,
};

export default CheckoutPageWithPayment;
