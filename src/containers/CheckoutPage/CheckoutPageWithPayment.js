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
  hasDefaultPaymentMethod,
} from './CheckoutPageTransactionHelpers.js';

import CustomTopbar from './CustomTopbar';
import StripePaymentForm from './StripePaymentForm/StripePaymentForm';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import css from './CheckoutPage.module.css';

/* ------------------------------------------------------------------
   Helpers LOCAUX pour supprimer la dépendance aux exports manquants
   ------------------------------------------------------------------ */

// si on ne gère pas encore une fenêtre d'expiration de paiement,
// on retourne toujours false
const hasPaymentExpiredLocal = () => false;

// idem: tant que la transaction n'est pas encore passée par l'étape "pending-payment",
// on dit false pour ne pas bloquer l'UI
const hasTransactionPassedPendingPaymentLocal = () => false;

// mini orchestrateur Stripe "placeholder" :
// on laisse la structure attendue par handleCardSubmit,
// mais on ne fait rien de Stripe ici -> on renvoie null
const processCheckoutWithPaymentLocal = async () => {
  return Promise.resolve(null);
};

// messages d'erreurs à afficher au dessus du formulaire
// Ici on retourne un objet avec juste des champs vides.
const getErrorMessagesLocal = (
  listingNotFound,
  initiateOrderError,
  isPaymentExpired,
  retrievePaymentIntentError,
  speculateTransactionError,
  listingLinkEl
) => {
  // Tu peux enrichir ces conditions si tu veux afficher du texte personnalisé
  return {
    initiateOrderErrorMessage: null,
    listingNotFoundErrorMessage: null,
    speculateErrorMessage: null,
    retrievePaymentIntentErrorMessage: null,
    paymentExpiredMessage: null,
    speculateTransactionErrorMessage: null,
  };
};

/**
 * Construit les params envoyés à l'API Flex
 * (remplace l'ancien getOrderParams pour qu'on ne dépende pas du helper global)
 */
const buildOrderParamsLocal = (pageData, optionalPaymentParams = {}) => {
  const { orderData = {}, listing } = pageData || {};
  const { bookingDates, quantity, deliveryMethod, paymentMethod } = orderData;

  const bookingParamsMaybe =
    bookingDates && bookingDates.start && bookingDates.end
      ? {
          bookingStart: bookingDates.start,
          bookingEnd: bookingDates.end,
        }
      : {};

  const quantityMaybe = quantity
    ? { stockReservationQuantity: quantity }
    : {};

  const deliveryMaybe = deliveryMethod
    ? { deliveryMethod }
    : {};

  const protectedData = {
    ...(orderData.protectedData || {}),
    paymentMethod: paymentMethod || 'card', // 'card' ou 'cash'
  };

  return {
    listingId: listing?.id,
    ...bookingParamsMaybe,
    ...quantityMaybe,
    ...deliveryMaybe,
    protectedData,
    ...optionalPaymentParams,
  };
};

/* ------------------------------------------------------------------
   COMPONENT
   ------------------------------------------------------------------ */

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

    // thunks / callbacks
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

  // ----- Data extraction -----
  const listing = pageData?.listing;
  const orderData = pageData?.orderData || {};
  const chosenPaymentMethod = orderData?.paymentMethod || 'card';

  const existingTransaction = ensureTransaction(pageData?.transaction);
  const speculatedTransaction = ensureTransaction(speculatedTransactionMaybe, {}, null);

  // tx = la transaction à afficher dans le breakdown :
  // soit celle qui existe déjà avec ses lineItems complets,
  // soit la transaction "speculated"
  const tx =
    existingTransaction?.attributes?.lineItems?.length > 0
      ? existingTransaction
      : speculatedTransaction;

  const timeZone = listing?.attributes?.availabilityPlan?.timezone;
  const transactionProcessAlias = listing?.attributes?.publicData?.transactionProcessAlias;
  const priceVariantName = tx?.attributes?.protectedData?.priceVariantName;

  const txBookingMaybe =
    tx?.booking?.id && timeZone
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

  // ici on utilise la version locale
  const isPaymentExpired = hasPaymentExpiredLocal(
    existingTransaction,
    process,
    isClockInSync
  );

  const listingNotFound =
    isTransactionInitiateListingNotFoundError(speculateTransactionError) ||
    isTransactionInitiateListingNotFoundError(initiateOrderError);

  // idem version locale
  const errorMessages = getErrorMessagesLocal(
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

  const transactionId = existingTransaction?.id || null;

  // ----- FLOW CASH -----
  const handleCashSubmit = () => {
    if (submitting) return;
    setSubmitting(true);

    // pas de Stripe dans ce cas
    const orderParams = buildOrderParamsLocal(pageData, {});

    onInitiateCashOrder(orderParams, transactionId)
      .then(response => {
        onSubmitCallback();

        // essaie de récupérer l'ID de transaction
        let orderId = null;
        if (
          response &&
          response.data &&
          response.data.data &&
          response.data.data.id
        ) {
          orderId = response.data.data.id;
        }
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

        if (orderId) {
          const orderDetailsPath = pathByRouteName(
            'OrderDetailsPage',
            routeConfiguration,
            { id: orderId }
          );
          history.push(orderDetailsPath);
        } else {
          history.push(
            pathByRouteName(
              'ListingPage',
              routeConfiguration,
              { id: listing?.id?.uuid }
            )
          );
        }

        setSubmitting(false);
      })
      .catch(err => {
        console.error('Failed to initiate cash order', err);
        setSubmitting(false);
      });
  };

  // ----- FLOW CB / STRIPE -----
  const handleCardSubmit = values => {
    if (submitting) return;
    setSubmitting(true);

    const optionalPaymentParams = {
      message: values?.message,
      setupPaymentMethod: values?.setupPaymentMethod,
      paymentIntentId: paymentIntent?.id,
      paymentMethodId: values?.paymentMethodId,
      stripePaymentMethodId: values?.stripePaymentMethodId,
      card: values?.card,
      stripe: stripeInstance,
    };

    const orderParams = buildOrderParamsLocal(
      pageData,
      optionalPaymentParams
    );

    processCheckoutWithPaymentLocal({
      orderParams,
      pageData,
      transactionId,
      stripeCustomerFetched,
      stripeCustomer: currentUser?.stripeCustomer,
      hasDefaultPaymentMethod: hasDefaultPaymentMethod(
        stripeCustomerFetched,
        currentUser
      ),
      hasTransactionPassedPendingPayment: hasTransactionPassedPendingPaymentLocal(
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

        if (orderId) {
          const orderDetailsPath = pathByRouteName(
            'OrderDetailsPage',
            routeConfiguration,
            { id: orderId }
          );
          history.push(orderDetailsPath);
        } else {
          history.push(
            pathByRouteName(
              'ListingPage',
              routeConfiguration,
              { id: listing?.id?.uuid }
            )
          );
        }

        setSubmitting(false);
      })
      .catch(e => {
        console.error('Card payment flow failed', e);
        setSubmitting(false);
      });
  };

  const showPaymentSection =
    currentUser &&
    !listingNotFound &&
    !initiateOrderError &&
    !speculateTransactionError &&
    !retrievePaymentIntentError &&
    !isPaymentExpired;

  const firstImage =
    listing?.images && listing.images.length > 0
      ? listing.images[0]
      : null;

  return (
    <Page title={title} scrollingDisabled={scrollingDisabled}>
      <CustomTopbar
        intl={intl}
        linkToExternalSite={config?.topbar?.logoLink}
      />

      <div className={css.contentContainer}>
        {/* IMAGE / HEADER MOBILE */}
        <MobileListingImage
          listingTitle={listingTitle}
          author={listing?.author}
          firstImage={firstImage}
          layoutListingImageConfig={
            config.layout.listingImage
          }
          showListingImage={showListingImage}
        />

        {/* COLONNE GAUCHE */}
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

            {chosenPaymentMethod === 'card' ? (
              showPaymentSection ? (
                <StripePaymentForm
                  className={css.paymentForm}
                  onSubmit={handleCardSubmit}
                  inProgress={submitting}
                  formId="CheckoutPagePaymentForm"
                  authorDisplayName={
                    listing?.author?.attributes?.profile
                      ?.displayName
                  }
                  showInitialMessageInput={true}
                  initialValues={{}}
                  initiateOrderError={initiateOrderError}
                  confirmCardPaymentError={
                    confirmCardPaymentError
                  }
                  confirmPaymentError={confirmPaymentError}
                  hasHandledCardPayment={false}
                  loadingData={!stripeCustomerFetched}
                  defaultPaymentMethod={
                    hasDefaultPaymentMethod(
                      stripeCustomerFetched,
                      currentUser
                    )
                      ? currentUser.stripeCustomer
                          .defaultPaymentMethod
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
                    listing?.attributes?.publicData
                      ?.location
                  }
                  totalPrice={totalPrice}
                  locale={config.localization.locale}
                  stripePublishableKey={
                    config.stripe.publishableKey
                  }
                  marketplaceName={
                    config.marketplaceName
                  }
                  isBooking={isBookingProcessAlias(
                    transactionProcessAlias
                  )}
                  isFuzzyLocation={
                    config.maps.fuzzy.enabled
                  }
                />
              ) : null
            ) : (
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

        {/* COLONNE DROITE */}
        <DetailsSideCard
          listing={listing}
          listingTitle={listingTitle}
          priceVariantName={priceVariantName}
          author={listing?.author}
          firstImage={firstImage}
          layoutListingImageConfig={
            config.layout.listingImage
          }
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
