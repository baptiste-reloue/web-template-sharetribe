import React, { useState } from 'react';
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { propTypes } from '../../util/types';
import { ensureTransaction } from '../../util/data';
import { isTransactionInitiateListingNotFoundError } from '../../util/errors';
import { getProcess, isBookingProcessAlias } from '../../transactions/transaction';
import { H3, H4, NamedLink, OrderBreakdown, Page } from '../../components';

// Imports sûrs depuis ton helper
import { getFormattedTotalPrice, hasDefaultPaymentMethod } from './CheckoutPageTransactionHelpers.js';

import CustomTopbar from './CustomTopbar';
import StripePaymentForm from './StripePaymentForm/StripePaymentForm';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import css from './CheckoutPage.module.css';

// Helpers "localisés" ultra-simples (pas de dépendances)
const hasPaymentExpiredLocal = () => false;
const hasTransactionPassedPendingPaymentLocal = () => false;
const processCheckoutWithPaymentLocal = async () => Promise.resolve(null);
const errorMsgs = {
  initiateOrderErrorMessage: null,
  listingNotFoundErrorMessage: null,
  speculateErrorMessage: null,
  retrievePaymentIntentErrorMessage: null,
  paymentExpiredMessage: null,
  speculateTransactionErrorMessage: null,
};

const buildOrderParamsLocal = (pageData, extra = {}) => {
  const { orderData = {}, listing } = pageData || {};
  const { bookingDates, quantity, deliveryMethod, paymentMethod } = orderData;

  const bookingParams =
    bookingDates && bookingDates.start && bookingDates.end
      ? { bookingStart: bookingDates.start, bookingEnd: bookingDates.end }
      : {};

  return {
    listingId: listing?.id,
    ...bookingParams,
    ...(quantity ? { stockReservationQuantity: quantity } : {}),
    ...(deliveryMethod ? { deliveryMethod } : {}),
    protectedData: { ...(orderData.protectedData || {}), paymentMethod: paymentMethod || 'card' },
    ...extra,
  };
};

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

    onInitiateCashOrder,
    onInitiateOrder,
    onConfirmCardPayment,
    onConfirmPayment,
    onSendMessage,
    onSavePaymentMethod,
    onRetrievePaymentIntent, // dispo via props (CheckoutPage.js)

    onSubmitCallback,
    setPageData,
  } = props;

  const listing = pageData?.listing;
  const orderData = pageData?.orderData || {};
  const chosenPaymentMethod = orderData?.paymentMethod || 'card';

  const existingTx = ensureTransaction(pageData?.transaction);
  const speculatedTx = ensureTransaction(speculatedTransactionMaybe, {}, null);
  const tx = existingTx?.attributes?.lineItems?.length > 0 ? existingTx : speculatedTx;

  const timeZone = listing?.attributes?.availabilityPlan?.timezone;
  const process = processName ? getProcess(processName) : null;
  const isPaymentExpired = hasPaymentExpiredLocal(existingTx, process, isClockInSync);

  const listingNotFound =
    isTransactionInitiateListingNotFoundError(speculateTransactionError) ||
    isTransactionInitiateListingNotFoundError(initiateOrderError);

  const breakdown =
    tx?.id && tx?.attributes?.lineItems?.length > 0 ? (
      <OrderBreakdown
        className={css.orderBreakdown}
        userRole="customer"
        transaction={tx}
        {...(tx?.booking?.id && timeZone ? { booking: tx.booking, timeZone } : {})}
        currency={config.currency}
        marketplaceName={config.marketplaceName}
      />
    ) : null;

  const totalPrice = tx?.attributes?.lineItems?.length > 0 ? getFormattedTotalPrice(tx, intl) : null;
  const transactionId = existingTx?.id || null;

  // Bouton "changer de mode" AVANT le titre
  const handleChangeMethod = () => {
    const updated = { ...pageData, orderData: { ...(orderData || {}), paymentMethod: null } };
    setPageData(updated);
  };

  // CASH
  const handleCashSubmit = () => {
    if (submitting) return;
    setSubmitting(true);
    const orderParams = buildOrderParamsLocal(pageData, {});
    onInitiateCashOrder(orderParams, transactionId)
      .then(res => {
        onSubmitCallback();
        const id =
          res?.data?.data?.id ||
          res?.payload?.data?.data?.id ||
          null;
        history.push(
          id
            ? pathByRouteName('OrderDetailsPage', routeConfiguration, { id })
            : pathByRouteName('ListingPage', routeConfiguration, { id: listing?.id?.uuid })
        );
        setSubmitting(false);
      })
      .catch(e => {
        console.error('Failed to initiate cash order', e);
        setSubmitting(false);
      });
  };

  // CARTE
  const handleCardSubmit = values => {
    if (submitting) return;
    setSubmitting(true);

    const extra = {
      message: values?.message,
      setupPaymentMethod: values?.setupPaymentMethod,
      paymentIntentId: paymentIntent?.id,
      paymentMethodId: values?.paymentMethodId,
      stripePaymentMethodId: values?.stripePaymentMethodId,
      card: values?.card,
      stripe: stripeInstance,
    };
    const orderParams = buildOrderParamsLocal(pageData, extra);

    processCheckoutWithPaymentLocal({
      orderParams,
      pageData,
      transactionId,
      stripeCustomerFetched,
      stripeCustomer: currentUser?.stripeCustomer,
      hasDefaultPaymentMethod: hasDefaultPaymentMethod(stripeCustomerFetched, currentUser),
      hasTransactionPassedPendingPayment: hasTransactionPassedPendingPaymentLocal(existingTx, process),
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
        history.push(
          orderId
            ? pathByRouteName('OrderDetailsPage', routeConfiguration, { id: orderId })
            : pathByRouteName('ListingPage', routeConfiguration, { id: listing?.id?.uuid })
        );
        setSubmitting(false);
      })
      .catch(e => {
        console.error('Card payment flow failed', e);
        setSubmitting(false);
      });
  };

  const firstImage = listing?.images?.length ? listing.images[0] : null;
  const showStripe = chosenPaymentMethod === 'card' && !listingNotFound && !isPaymentExpired;

  return (
    <Page title={title} scrollingDisabled={scrollingDisabled}>
      <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />

      <div className={css.contentContainer}>
        <div className={css.orderFormContainer}>
          {/* Changer de mode (retour) */}
          <div style={{ marginBottom: 12 }}>
            <button type="button" className="buttonSecondary" onClick={handleChangeMethod}>
              <FormattedMessage id="CheckoutPage.changePayment" defaultMessage="⟵ Changer de mode de paiement" />
            </button>
          </div>

          {/* Image mobile + titres */}
          <MobileListingImage
            listingTitle={listingTitle}
            author={listing?.author}
            firstImage={firstImage}
            layoutListingImageConfig={config.layout.listingImage}
            showListingImage={showListingImage}
          />

          <div className={css.headingContainer}>
            <H3 as="h1" className={css.heading}>{title}</H3>
            <H4 as="h2" className={css.detailsHeadingMobile}>
              <FormattedMessage id="CheckoutPage.listingTitle" values={{ listingTitle }} />
            </H4>
          </div>

          <MobileOrderBreakdown
            speculateTransactionErrorMessage={errorMsgs.speculateTransactionErrorMessage}
            breakdown={breakdown}
            priceVariantName={tx?.attributes?.protectedData?.priceVariantName}
          />

          <section className={css.paymentContainer}>
            {showStripe ? (
              <StripePaymentForm
                key="stripe-form"
                className={css.paymentForm}
                onSubmit={handleCardSubmit}
                inProgress={submitting}
                formId="CheckoutPagePaymentForm"
                authorDisplayName={listing?.author?.attributes?.profile?.displayName}
                showInitialMessageInput={true}
                initialValues={{}}
                initiateOrderError={initiateOrderError}
                confirmCardPaymentError={confirmCardPaymentError}
                confirmPaymentError={confirmPaymentError}
                hasHandledCardPayment={false}
                loadingData={false}  // on n'empêche pas l'affichage
                defaultPaymentMethod={
                  hasDefaultPaymentMethod(stripeCustomerFetched, currentUser)
                    ? currentUser.stripeCustomer.defaultPaymentMethod
                    : null
                }
                paymentIntent={paymentIntent || null}
                onStripeInitialized={setStripeInstance}
                askShippingDetails={orderData?.deliveryMethod === 'shipping'}
                showPickUplocation={orderData?.deliveryMethod === 'pickup'}
                listingLocation={listing?.attributes?.publicData?.location}
                totalPrice={totalPrice}
                locale={config.localization.locale}
                stripePublishableKey={config.stripe.publishableKey}
                marketplaceName={config.marketplaceName}
                isBooking={isBookingProcessAlias(listing?.attributes?.publicData?.transactionProcessAlias)}
                isFuzzyLocation={config.maps.fuzzy.enabled}
              />
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
                  <button className="button" disabled={submitting} onClick={handleCashSubmit}>
                    {submitting ? (
                      <FormattedMessage id="CheckoutPage.sending" defaultMessage="Envoi..." />
                    ) : (
                      <FormattedMessage id="CheckoutPage.sendRequest" defaultMessage="Envoyer la demande" />
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
          priceVariantName={tx?.attributes?.protectedData?.priceVariantName}
          author={listing?.author}
          firstImage={firstImage}
          layoutListingImageConfig={config.layout.listingImage}
          speculateTransactionErrorMessage={errorMsgs.speculateTransactionErrorMessage}
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
  onRetrievePaymentIntent: propTypes.func.isRequired,
  onSubmitCallback: propTypes.func.isRequired,
  setPageData: propTypes.func.isRequired,
};

export default CheckoutPageWithPayment;
