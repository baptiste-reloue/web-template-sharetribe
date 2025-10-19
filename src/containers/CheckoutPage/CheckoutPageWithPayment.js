// src/containers/CheckoutPage/CheckoutPageWithPayment.js
import React, { useState } from 'react';
import { Form } from 'react-final-form';

// Utils & transactions
import { FormattedMessage, intlShape } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { isValidCurrencyForTransactionProcess } from '../../util/fieldHelpers.js';
import { propTypes } from '../../util/types';
import { ensureTransaction } from '../../util/data';
import { createSlug } from '../../util/urlHelpers';
import { isTransactionInitiateListingNotFoundError } from '../../util/errors';
import { getProcess, isBookingProcessAlias } from '../../transactions/transaction';

// UI components
import {
  H3,
  H4,
  NamedLink,
  OrderBreakdown,
  Page,
  FieldRadioButton,
  FieldTextInput,
  PrimaryButton,
} from '../../components';

// Helpers
import {
  bookingDatesMaybe,
  getBillingDetails,
  getFormattedTotalPrice,
  getShippingDetailsMaybe,
  getTransactionTypeData,
  hasDefaultPaymentMethod,
  hasPaymentExpired,
  hasTransactionPassedPendingPayment,
  processCheckoutWithPayment,
  setOrderPageInitialValues,
} from './CheckoutPageTransactionHelpers.js';
import { getErrorMessages } from './ErrorMessages';

// Local parts
import CustomTopbar from './CustomTopbar';
import StripePaymentForm from './StripePaymentForm/StripePaymentForm';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import css from './CheckoutPage.module.css';

// Stripe: états où les actions utilisateur sont déjà effectuées
const STRIPE_PI_USER_ACTIONS_DONE_STATUSES = ['processing', 'requires_capture', 'succeeded'];

// Flux de paiement Stripe
const ONETIME_PAYMENT = 'ONETIME_PAYMENT';
const PAY_AND_SAVE_FOR_LATER_USE = 'PAY_AND_SAVE_FOR_LATER_USE';
const USE_SAVED_CARD = 'USE_SAVED_CARD';

const paymentFlow = (selectedPaymentMethod, saveAfterOnetimePayment) => {
  return selectedPaymentMethod === 'defaultCard'
    ? USE_SAVED_CARD
    : saveAfterOnetimePayment
    ? PAY_AND_SAVE_FOR_LATER_USE
    : ONETIME_PAYMENT;
};

const capitalizeString = s => `${s.charAt(0).toUpperCase()}${s.substr(1)}`;

/** Préfixer les propriétés du priceVariant dans protectedData */
const prefixPriceVariantProperties = priceVariant => {
  if (!priceVariant) return {};
  const entries = Object.entries(priceVariant).map(([key, value]) => [
    `priceVariant${capitalizeString(key)}`,
    value,
  ]);
  return Object.fromEntries(entries);
};

/** Construire orderParams (pour speculate + submit réel) */
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
    ...optionalPaymentParams,
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

/** Charger Stripe + speculate (gardé tel quel) */
export const loadInitialDataForStripePayments = ({
  pageData,
  fetchSpeculatedTransaction,
  fetchStripeCustomer,
  config,
}) => {
  fetchStripeCustomer();
  const shippingDetails = {};
  const optionalPaymentParams = {};
  const orderParams = getOrderParams(pageData, shippingDetails, optionalPaymentParams, config);
  fetchSpeculatedTransactionIfNeeded(orderParams, pageData, fetchSpeculatedTransaction);
};

/* ====== CASH: alias & transition ====== */
const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';
const CASH_INITIAL_TRANSITION = 'transition/request';

/* ====== STRIPE submit ====== */
const handleSubmitStripe = (values, process, props, stripe, submitting, setSubmitting) => {
  if (submitting) return;
  setSubmitting(true);

  const {
    history,
    config,
    routeConfiguration,
    speculatedTransaction,
    currentUser,
    stripeCustomerFetched,
    paymentIntent,
    dispatch,
    onInitiateOrder,
    onConfirmCardPayment,
    onConfirmPayment,
    onSendMessage,
    onSavePaymentMethod,
    onSubmitCallback,
    pageData,
    setPageData,
    sessionStorageKey,
  } = props;

  const { card, message, paymentMethod: selectedPaymentMethod, formValues } = values;
  const { saveAfterOnetimePayment: saveAfterOnetimePaymentRaw } = formValues;

  const saveAfterOnetimePayment =
    Array.isArray(saveAfterOnetimePaymentRaw) && saveAfterOnetimePaymentRaw.length > 0;
  const selectedPaymentFlow = paymentFlow(selectedPaymentMethod, saveAfterOnetimePayment);
  const hasDefaultPaymentMethodSaved = hasDefaultPaymentMethod(stripeCustomerFetched, currentUser);
  const stripePaymentMethodId = hasDefaultPaymentMethodSaved
    ? currentUser?.stripeCustomer?.defaultPaymentMethod?.attributes?.stripePaymentMethodId
    : null;

  const hasPaymentIntentUserActionsDone =
    paymentIntent && STRIPE_PI_USER_ACTIONS_DONE_STATUSES.includes(paymentIntent.status);

  const requestPaymentParams = {
    pageData,
    speculatedTransaction,
    stripe,
    card,
    billingDetails: getBillingDetails(formValues, currentUser),
    message,
    paymentIntent,
    hasPaymentIntentUserActionsDone,
    stripePaymentMethodId,
    process,
    onInitiateOrder,
    onConfirmCardPayment,
    onConfirmPayment,
    onSendMessage,
    onSavePaymentMethod,
    sessionStorageKey,
    stripeCustomer: currentUser?.stripeCustomer,
    isPaymentFlowUseSavedCard: selectedPaymentFlow === USE_SAVED_CARD,
    isPaymentFlowPayAndSaveCard: selectedPaymentFlow === PAY_AND_SAVE_FOR_LATER_USE,
    setPageData,
  };

  const shippingDetails = getShippingDetailsMaybe(formValues);
  const optionalPaymentParams =
    selectedPaymentFlow === USE_SAVED_CARD && hasDefaultPaymentMethodSaved
      ? { paymentMethod: stripePaymentMethodId }
      : selectedPaymentFlow === PAY_AND_SAVE_FOR_LATER_USE
      ? { setupPaymentMethodForSaving: true }
      : {};

  const orderParams = getOrderParams(pageData, shippingDetails, optionalPaymentParams, config);

  processCheckoutWithPayment(orderParams, requestPaymentParams)
    .then(response => {
      const { orderId, messageSuccess, paymentMethodSaved } = response;
      setSubmitting(false);

      const initialMessageFailedToTransaction = messageSuccess ? null : orderId;
      const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, {
        id: orderId.uuid,
      });
      const initialValues = {
        initialMessageFailedToTransaction,
        savePaymentMethodFailed: !paymentMethodSaved,
      };

      setOrderPageInitialValues(initialValues, routeConfiguration, dispatch);
      onSubmitCallback();
      history.push(orderDetailsPath);
    })
    .catch(err => {
      console.error(err);
      setSubmitting(false);
    });
};

/* ====== STRIPE init (PaymentIntent refresh) ====== */
const onStripeInitialized = (stripe, process, props) => {
  const { paymentIntent, onRetrievePaymentIntent, pageData } = props;
  const tx = pageData?.transaction || null;

  const shouldFetchPaymentIntent =
    stripe &&
    !paymentIntent &&
    tx?.id &&
    process?.getState(tx) === process?.states.PENDING_PAYMENT &&
    !hasPaymentExpired(tx, process);

  if (shouldFetchPaymentIntent) {
    const { stripePaymentIntentClientSecret } =
      tx.attributes.protectedData?.stripePaymentIntents?.default || {};
    onRetrievePaymentIntent({ stripe, stripePaymentIntentClientSecret });
  }
};

/* =======================================================
   COMPOSANT PRINCIPAL
   ======================================================= */
export const CheckoutPageWithPayment = props => {
  const [submitting, setSubmitting] = useState(false);
  const [stripe, setStripe] = useState(null);
  const [paymentMode, setPaymentMode] = useState('card'); // 'card' | 'cash'

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
    routeConfiguration,
    history,
    onInitiateOrder,
    onSubmitCallback,
    dispatch,
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
  const transitions = process.transitions;
  const isPaymentExpired = hasPaymentExpired(existingTransaction, process, isClockInSync);

  const showPaymentForm = !!(
    currentUser &&
    !listingNotFound &&
    !initiateOrderError &&
    !speculateTransactionError &&
    !retrievePaymentIntentError &&
    !isPaymentExpired
  );

  const firstImage = listing?.images?.length > 0 ? listing.images[0] : null;

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
    isPaymentExpired,
    retrievePaymentIntentError,
    speculateTransactionError,
    listingLink
  );

  const txTransitions = existingTransaction?.attributes?.transitions || [];
  const hasInquireTransition = txTransitions.find(tr => tr.transition === transitions.INQUIRE);
  const showInitialMessageInput = !hasInquireTransition;

  const userName = currentUser?.attributes?.profile
    ? `${currentUser.attributes.profile.firstName} ${currentUser.attributes.profile.lastName}`
    : null;

  const hasPaymentIntentUserActionsDone =
    paymentIntent && STRIPE_PI_USER_ACTIONS_DONE_STATUSES.includes(paymentIntent.status);

  const initialValuesForStripePayment = { name: userName, recipientName: userName };
  const askShippingDetails =
    orderData?.deliveryMethod === 'shipping' &&
    !hasTransactionPassedPendingPayment(existingTransaction, process);

  // Stripe compatible ?
  const isStripeCompatibleCurrency = isValidCurrencyForTransactionProcess(
    transactionProcessAlias,
    listing.attributes.price.currency,
    'stripe'
  );

  if (!isStripeCompatibleCurrency) {
    return (
      <Page title={title} scrollingDisabled={scrollingDisabled}>
        <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
        <div className={css.contentContainer}>
          <section className={css.incompatibleCurrency}>
            <H4 as="h1" className={css.heading}>
              <FormattedMessage id="CheckoutPage.incompatibleCurrency" />
            </H4>
          </section>
        </div>
      </Page>
    );
  }

  /* ========= Soumission CASH ========= */
  const submitCash = async formValues => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const shippingDetails = getShippingDetailsMaybe(formValues) || {};
      const orderParams = getOrderParams(pageData, shippingDetails, {}, config);

      // Tag pour suivi côté BO
      orderParams.protectedData = {
        ...(orderParams.protectedData || {}),
        paymentMethod: 'cash',
        billingName: formValues?.name || userName || '',
      };

      const res = await onInitiateOrder(
        orderParams,
        CASH_PROCESS_ALIAS,
        null,
        CASH_INITIAL_TRANSITION,
        true
      );

      const txRes = res?.payload?.data || res?.data || res;
      const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, {
        id: txRes.id.uuid,
      });

      setSubmitting(false);
      onSubmitCallback && onSubmitCallback();
      history.push(orderDetailsPath);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
      setSubmitting(false);
    }
  };

  /* ========= Formulaire CASH (coordonnées de facturation + message) ========= */
  const CashBillingForm = () => (
    <Form
      onSubmit={submitCash}
      initialValues={{
        name: userName || '',
        addressLine1: '',
        addressLine2: '',
        postal: '',
        city: '',
        state: '',
        country: '',
        message: '',
      }}
      render={({ handleSubmit, submitting: ffSubmitting }) => (
        <form className={css.cashForm} onSubmit={handleSubmit}>
          <div className={css.sectionTitle}>
            <FormattedMessage id="CheckoutPage.billingDetailsTitle" defaultMessage="Détails de facturation" />
          </div>

          <div className={css.gridTwoCols}>
            <FieldTextInput id="name" name="name" type="text" label="Nom du titulaire" required />
            <FieldTextInput id="recipientName" name="recipientName" type="text" label="Nom du destinataire" />
            <FieldTextInput id="addressLine1" name="addressLine1" type="text" label="Adresse" />
            <FieldTextInput id="addressLine2" name="addressLine2" type="text" label="Complément (optionnel)" />
            <FieldTextInput id="postal" name="postal" type="text" label="Code postal" />
            <FieldTextInput id="city" name="city" type="text" label="Ville" />
            <FieldTextInput id="state" name="state" type="text" label="État (optionnel)" />
            <FieldTextInput id="country" name="country" type="text" label="Pays" />
          </div>

          <div className={css.sectionTitle}>
            <FormattedMessage id="CheckoutPage.additionalInfoTitle" defaultMessage="Informations additionnelles" />
          </div>
          <FieldTextInput
            id="message"
            name="message"
            type="text"
            label="Y a-t-il quelque chose que le propriétaire devrait savoir ? (optionnel)"
          />

          <PrimaryButton
            className={css.submitButton}
            type="submit"
            inProgress={submitting || ffSubmitting}
            disabled={submitting || ffSubmitting}
          >
            <FormattedMessage id="CheckoutPage.cash.submit" defaultMessage="Demander en espèces" />
          </PrimaryButton>
        </form>
      )}
    />
  );

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
            {errorMessages.retrievePaymentIntentErrorMessage}
            {errorMessages.paymentExpiredMessage}

            {showPaymentForm ? (
              <>
                {/* Lieu de l'objet */}
                {orderData?.deliveryMethod === 'pickup' ? (
                  <div className={css.pickupAddressBox}>
                    <div className={css.sectionTitle}>
                      <FormattedMessage id="CheckoutPage.pickupLocation" defaultMessage="Lieu de l'objet" />
                    </div>
                    <div className={css.pickupAddressLine}>
                      {listing?.attributes?.publicData?.location?.address}
                    </div>
                  </div>
                ) : null}

                {/* ====== Sélecteur de mode de paiement ====== */}
                <div className={css.sectionTitle}>
                  <FormattedMessage id="CheckoutPage.payment" defaultMessage="Paiement" />
                </div>
                <div className={css.paymentChoiceRow}>
                  <FieldRadioButton
                    id="pm-card"
                    name="paymentMode"
                    value="card"
                    label={<span>Carte<br />(Stripe)</span>}
                    checked={paymentMode === 'card'}
                    onChange={() => setPaymentMode('card')}
                    className={css.paymentRadio}
                  />
                  <FieldRadioButton
                    id="pm-cash"
                    name="paymentMode"
                    value="cash"
                    label={<span>Espèces<br />à la remise</span>}
                    checked={paymentMode === 'cash'}
                    onChange={() => setPaymentMode('cash')}
                    className={css.paymentRadio}
                  />
                </div>

                {/* ====== Formulaires ====== */}
                {paymentMode === 'card' ? (
                  <StripePaymentForm
                    className={css.paymentForm}
                    onSubmit={values =>
                      handleSubmitStripe(values, process, props, stripe, submitting, setSubmitting)
                    }
                    inProgress={submitting}
                    formId="CheckoutPagePaymentForm"
                    authorDisplayName={listing?.author?.attributes?.profile?.displayName}
                    showInitialMessageInput={showInitialMessageInput}
                    initialValues={initialValuesForStripePayment}
                    initiateOrderError={initiateOrderError}
                    confirmCardPaymentError={confirmCardPaymentError}
                    confirmPaymentError={confirmPaymentError}
                    hasHandledCardPayment={hasPaymentIntentUserActionsDone}
                    loadingData={!stripeCustomerFetched}
                    defaultPaymentMethod={
                      hasDefaultPaymentMethod(stripeCustomerFetched, currentUser)
                        ? currentUser.stripeCustomer.defaultPaymentMethod
                        : null
                    }
                    paymentIntent={paymentIntent}
                    onStripeInitialized={s => {
                      setStripe(s);
                      return onStripeInitialized(s, process, props);
                    }}
                    askShippingDetails={askShippingDetails}
                    showPickUplocation={orderData?.deliveryMethod === 'pickup'}
                    listingLocation={listing?.attributes?.publicData?.location}
                    totalPrice={totalPrice}
                    locale={config.localization.locale}
                    stripePublishableKey={config.stripe.publishableKey}
                    marketplaceName={config.marketplaceName}
                    isBooking={isBookingProcessAlias(transactionProcessAlias)}
                    isFuzzyLocation={config.maps.fuzzy.enabled}
                  />
                ) : (
                  <CashBillingForm />
                )}
              </>
            ) : null}
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

CheckoutPageWithPayment.defaultProps = {
  speculatedTransaction: null,
  paymentIntent: null,
};

CheckoutPageWithPayment.propTypes = {
  // keep types aligned with original file (not exhaustively listed here)
  intl: intlShape.isRequired,
  pageData: propTypes.object.isRequired,
  listingTitle: propTypes.string,
  title: propTypes.string,
};

export default CheckoutPageWithPayment;
