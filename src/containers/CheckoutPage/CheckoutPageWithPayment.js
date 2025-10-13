import React, { useState } from 'react';

// Import contexts and util modules
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { isValidCurrencyForTransactionProcess } from '../../util/fieldHelpers.js';
import { ensureTransaction } from '../../util/data';
import { createSlug } from '../../util/urlHelpers';
import { isTransactionInitiateListingNotFoundError } from '../../util/errors';
import { getProcess, isBookingProcessAlias } from '../../transactions/transaction';

// Import shared components
import { H3, H4, NamedLink, OrderBreakdown, Page, PrimaryButton } from '../../components';

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

import CustomTopbar from './CustomTopbar';
import StripePaymentForm from './StripePaymentForm/StripePaymentForm';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import css from './CheckoutPage.module.css';

// Stripe PaymentIntent statuses, where user actions are already completed
const STRIPE_PI_USER_ACTIONS_DONE_STATUSES = ['processing', 'requires_capture', 'succeeded'];

// Cash process constants
const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';
const CASH_INITIAL_TRANSITION = 'transition/request';

// ---- helpers ----
const paymentFlow = (selectedPaymentMethod, saveAfterOnetimePayment) =>
  selectedPaymentMethod === 'defaultCard'
    ? 'USE_SAVED_CARD'
    : saveAfterOnetimePayment
    ? 'PAY_AND_SAVE_FOR_LATER_USE'
    : 'ONETIME_PAYMENT';

const capitalizeString = s => `${s.charAt(0).toUpperCase()}${s.substr(1)}`;

const prefixPriceVariantProperties = priceVariant => {
  if (!priceVariant) return {};
  const entries = Object.entries(priceVariant).map(([key, value]) => [
    `priceVariant${capitalizeString(key)}`,
    value,
  ]);
  return Object.fromEntries(entries);
};

/**
 * Build order params for the first transition
 */
const getOrderParams = (pageData, shippingDetails, optionalPaymentParams, config) => {
  const quantity = pageData.orderData?.quantity;
  const quantityMaybe = quantity ? { quantity } : {};

  const seats = pageData.orderData?.seats;
  const seatsMaybe = seats ? { seats } : {};

  const deliveryMethod = pageData.orderData?.deliveryMethod;
  const deliveryMethodMaybe = deliveryMethod ? { deliveryMethod } : {};

  const { listingType, unitType, priceVariants } =
    pageData?.listing?.attributes?.publicData || {};

  // price variant data for fixed duration bookings
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

  // If transaction has passed payment-pending state, speculated tx is not needed.
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

/** Stripe-only initial data loader (unchanged) */
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

// Submit with Stripe
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

  // If paymentIntent status is not waiting user action,
  // confirmCardPayment has been called previously.
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
    isPaymentFlowUseSavedCard: selectedPaymentFlow === 'USE_SAVED_CARD',
    isPaymentFlowPayAndSaveCard: selectedPaymentFlow === 'PAY_AND_SAVE_FOR_LATER_USE',
    setPageData,
  };

  const shippingDetails = getShippingDetailsMaybe(formValues);
  // Optional Stripe params for the initiate transition
  const optionalPaymentParams =
    selectedPaymentFlow === 'USE_SAVED_CARD' && hasDefaultPaymentMethodSaved
      ? { paymentMethod: stripePaymentMethodId }
      : selectedPaymentFlow === 'PAY_AND_SAVE_FOR_LATER_USE'
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

const onStripeInitialized = (stripe, process, props) => {
  const { paymentIntent, onRetrievePaymentIntent, pageData } = props;
  const tx = pageData?.transaction || null;

  // We need to get up to date PI, if payment is pending but it's not expired.
  const shouldFetchPaymentIntent =
    stripe &&
    !paymentIntent &&
    tx?.id &&
    process?.getState(tx) === process?.states.PENDING_PAYMENT &&
    !hasPaymentExpired(tx, process);

  if (shouldFetchPaymentIntent) {
    const { stripePaymentIntentClientSecret } =
      tx.attributes.protectedData?.stripePaymentIntents?.default || {};

    // Fetch up to date PaymentIntent from Stripe
    onRetrievePaymentIntent({ stripe, stripePaymentIntentClientSecret });
  }
};

// Submit with cash
const handleSubmitCash = async (billingValues, props, setSubmitting) => {
  const {
    routeConfiguration,
    history,
    pageData,
    config,
    onInitiateOrder,
    onSubmitCallback,
  } = props;

  setSubmitting(true);

  try {
    const orderParams = getOrderParams(pageData, {}, {}, config);
    orderParams.protectedData = {
      ...(orderParams.protectedData || {}),
      paymentMethod: 'cash',
      billingDetails: billingValues,
    };

    const res = await onInitiateOrder(
      orderParams,
      CASH_PROCESS_ALIAS,
      null,
      CASH_INITIAL_TRANSITION,
      true
    );

    const createdTx = res?.payload?.data || res?.data || res;
    const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, {
      id: createdTx.id.uuid,
    });

    setSubmitting(false);
    onSubmitCallback && onSubmitCallback();
    history.push(orderDetailsPath);
  } catch (e) {
    console.error(e);
    setSubmitting(false);
  }
};

/**
 * Checkout page with payment (Stripe OR Cash)
 */
export const CheckoutPageWithPayment = props => {
  const [submitting, setSubmitting] = useState(false);
  const [stripe, setStripe] = useState(null);

  // Local UI state for payment choice and billing info (cash)
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
  } = props;

  const [paymentMethod, setPaymentMethod] = useState('stripe'); // 'stripe' | 'cash'
  const [billingValues, setBillingValues] = useState({
    name: currentUser?.attributes?.profile
      ? `${currentUser.attributes.profile.firstName} ${currentUser.attributes.profile.lastName}`
      : '',
    email: currentUser?.attributes?.email || '',
    addressLine1: '',
    city: '',
    postalCode: '',
    country: '',
  });
  const [cashNote, setCashNote] = useState('');

  const isCash = paymentMethod === 'cash';

  // Listing/transaction context
  const listingNotFound =
    isTransactionInitiateListingNotFoundError(speculateTransactionError) ||
    isTransactionInitiateListingNotFoundError(initiateOrderError);

  const { listing, transaction, orderData } = pageData;
  const existingTransaction = ensureTransaction(transaction);
  const speculatedTransaction = ensureTransaction(speculatedTransactionMaybe, {}, null);

  // Prefer an existing transaction that already has line items
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

  // Basic data for Stripe form
  const userName = currentUser?.attributes?.profile
    ? `${currentUser.attributes.profile.firstName} ${currentUser.attributes.profile.lastName}`
    : null;

  // If paymentIntent status is not waiting user action,
  // confirmCardPayment has been called previously.
  const hasPaymentIntentUserActionsDone =
    paymentIntent && STRIPE_PI_USER_ACTIONS_DONE_STATUSES.includes(paymentIntent.status);

  const askShippingDetails =
    orderData?.deliveryMethod === 'shipping' &&
    !hasTransactionPassedPendingPayment(existingTransaction, process);

  // Check currency – ignored if cash is selected
  const isStripeCompatibleCurrency =
    isCash ||
    isValidCurrencyForTransactionProcess(
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

  // ---- RENDER ----
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

            {/* === Sélecteur "Carte / Espèces" placé DANS la section Paiement === */}
            <div className={css.paymentMethodSection}>
              <div className={css.radioRow}>
                <label className={css.radioLabel}>
                  <input
                    type="radio"
                    name="pm"
                    value="stripe"
                    checked={paymentMethod !== 'cash'}
                    onChange={() => setPaymentMethod('stripe')}
                  />
                  <span>Carte (Stripe)</span>
                </label>
                <label className={css.radioLabel}>
                  <input
                    type="radio"
                    name="pm"
                    value="cash"
                    checked={paymentMethod === 'cash'}
                    onChange={() => setPaymentMethod('cash')}
                  />
                  <span>Espèces à la remise</span>
                </label>
              </div>
            </div>

            {/* Le reste du formulaire reste identique – on retire seulement le bloc carte en mode cash */}
            {showPaymentForm ? (
              paymentMethod === 'cash' ? (
                <div className={css.cashBox}>
                  {/* Détails de facturation (identiques visuellement) */}
                  <div className={css.formGrid}>
                    <div className={css.formItem}>
                      <label htmlFor="bd-name">Nom du titulaire</label>
                      <input
                        id="bd-name"
                        value={billingValues.name}
                        onChange={e =>
                          setBillingValues(v => ({ ...v, name: e.target.value }))
                        }
                      />
                    </div>
                    <div className={css.formItem}>
                      <label htmlFor="bd-email">Email</label>
                      <input
                        id="bd-email"
                        type="email"
                        value={billingValues.email}
                        onChange={e =>
                          setBillingValues(v => ({ ...v, email: e.target.value }))
                        }
                      />
                    </div>
                    <div className={css.formItem}>
                      <label htmlFor="bd-address">Adresse</label>
                      <input
                        id="bd-address"
                        value={billingValues.addressLine1}
                        onChange={e =>
                          setBillingValues(v => ({ ...v, addressLine1: e.target.value }))
                        }
                      />
                    </div>
                    <div className={css.formItem}>
                      <label htmlFor="bd-city">Ville</label>
                      <input
                        id="bd-city"
                        value={billingValues.city}
                        onChange={e =>
                          setBillingValues(v => ({ ...v, city: e.target.value }))
                        }
                      />
                    </div>
                    <div className={css.formItem}>
                      <label htmlFor="bd-postal">Code postal</label>
                      <input
                        id="bd-postal"
                        value={billingValues.postalCode}
                        onChange={e =>
                          setBillingValues(v => ({ ...v, postalCode: e.target.value }))
                        }
                      />
                    </div>
                    <div className={css.formItem}>
                      <label htmlFor="bd-country">Pays</label>
                      <input
                        id="bd-country"
                        value={billingValues.country}
                        onChange={e =>
                          setBillingValues(v => ({ ...v, country: e.target.value }))
                        }
                      />
                    </div>
                  </div>

                  {/* Informations additionnelles (message) */}
                  <div className={css.formItem} style={{ marginTop: 12 }}>
                    <label htmlFor="bd-message">Informations additionnelles</label>
                    <textarea
                      id="bd-message"
                      rows={3}
                      value={cashNote}
                      onChange={e => setCashNote(e.target.value)}
                    />
                  </div>

                  <PrimaryButton
                    className={css.submitButton}
                    type="button"
                    onClick={() =>
                      handleSubmitCash(
                        { ...billingValues, note: cashNote },
                        { ...props, routeConfiguration, history },
                        setSubmitting
                      )
                    }
                    inProgress={submitting}
                    disabled={
                      submitting ||
                      !billingValues.name ||
                      !billingValues.email ||
                      !billingValues.addressLine1 ||
                      !billingValues.city ||
                      !billingValues.postalCode ||
                      !billingValues.country
                    }
                  >
                    {submitting ? 'Envoi…' : 'Demander en espèces'}
                  </PrimaryButton>
                </div>
              ) : (
                <StripePaymentForm
                  className={css.paymentForm}
                  onSubmit={values =>
                    handleSubmitStripe(values, process, props, stripe, submitting, setSubmitting)
                  }
                  inProgress={submitting}
                  formId="CheckoutPagePaymentForm"
                  authorDisplayName={listing?.author?.attributes?.profile?.displayName}
                  showInitialMessageInput={showInitialMessageInput}
                  initialValues={{ name: userName, recipientName: userName }}
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
                  onStripeInitialized={stripeObj => {
                    setStripe(stripeObj);
                    return onStripeInitialized(stripeObj, process, props);
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
              )
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

export default CheckoutPageWithPayment;
