import React, { useState } from 'react';

import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { isValidCurrencyForTransactionProcess } from '../../util/fieldHelpers.js';
import { ensureTransaction } from '../../util/data';
import { createSlug } from '../../util/urlHelpers';
import { isTransactionInitiateListingNotFoundError } from '../../util/errors';
import { getProcess, isBookingProcessAlias } from '../../transactions/transaction';

import {
  H3,
  H4,
  NamedLink,
  OrderBreakdown,
  Page,
  PrimaryButton,
  Form as FinalForm,
  FieldTextInput,
  FieldTextArea,
} from '../../components';

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

// Stripe statuses that don't require further user action
const STRIPE_PI_USER_ACTIONS_DONE_STATUSES = ['processing', 'requires_capture', 'succeeded'];

// Cash process (alias/version à jour)
const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';
const CASH_INITIAL_TRANSITION = 'transition/request';

// ---------- helpers ----------
const capitalize = s => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

const prefixPriceVariantProperties = pv =>
  pv
    ? Object.fromEntries(Object.entries(pv).map(([k, v]) => [`priceVariant${capitalize(k)}`, v]))
    : {};

const paymentFlow = (selectedPaymentMethod, saveAfterOnetimePayment) =>
  selectedPaymentMethod === 'defaultCard'
    ? 'USE_SAVED_CARD'
    : saveAfterOnetimePayment
    ? 'PAY_AND_SAVE_FOR_LATER_USE'
    : 'ONETIME_PAYMENT';

const getOrderParams = (pageData, shippingDetails, optionalPaymentParams, config) => {
  const quantity = pageData.orderData?.quantity;
  const seats = pageData.orderData?.seats;
  const deliveryMethod = pageData.orderData?.deliveryMethod;

  const qMaybe = quantity ? { quantity } : {};
  const seatsMaybe = seats ? { seats } : {};
  const deliveryMaybe = deliveryMethod ? { deliveryMethod } : {};

  const { listingType, unitType, priceVariants } =
    pageData?.listing?.attributes?.publicData || {};

  const priceVariantName = pageData.orderData?.priceVariantName;
  const priceVariant = priceVariants?.find(pv => pv.name === priceVariantName);

  const protectedDataMaybe = {
    protectedData: {
      ...getTransactionTypeData(listingType, unitType, config),
      ...deliveryMaybe,
      ...shippingDetails,
      ...prefixPriceVariantProperties(priceVariant),
    },
  };

  return {
    listingId: pageData?.listing?.id,
    ...deliveryMaybe,
    ...qMaybe,
    ...seatsMaybe,
    ...bookingDatesMaybe(pageData.orderData?.bookingDates),
    ...(priceVariantName ? { priceVariantName } : {}),
    ...protectedDataMaybe,
    ...optionalPaymentParams,
  };
};

const fetchSpeculatedTransactionIfNeeded = (orderParams, pageData, fetchSpeculatedTransaction) => {
  const tx = pageData ? pageData.transaction : null;
  const listing = pageData.listing;
  const processName =
    tx?.attributes?.processName ||
    listing?.attributes?.publicData?.transactionProcessAlias?.split('/')[0];
  const process = processName ? getProcess(processName) : null;

  const shouldFetch =
    !!listing?.id && !!pageData.orderData && !!process && !hasTransactionPassedPendingPayment(tx, process);

  if (shouldFetch) {
    const processAlias = listing.attributes.publicData?.transactionProcessAlias;
    const txId = tx ? tx.id : null;
    const wasInquiry = tx?.attributes?.lastTransition === process.transitions.INQUIRE;

    const requestTransition = wasInquiry
      ? process.transitions.REQUEST_PAYMENT_AFTER_INQUIRY
      : process.transitions.REQUEST_PAYMENT;
    const isPrivileged = process.isPrivileged(requestTransition);

    fetchSpeculatedTransaction(orderParams, processAlias, txId, requestTransition, isPrivileged);
  }
};

export const loadInitialDataForStripePayments = ({
  pageData,
  fetchSpeculatedTransaction,
  fetchStripeCustomer,
  config,
}) => {
  fetchStripeCustomer();
  const orderParams = getOrderParams(pageData, {}, {}, config);
  fetchSpeculatedTransactionIfNeeded(orderParams, pageData, fetchSpeculatedTransaction);
};

// ---------- submit Stripe ----------
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
  const { saveAfterOnetimePayment: saveAfterRaw } = formValues;

  const saveAfter = Array.isArray(saveAfterRaw) && saveAfterRaw.length > 0;
  const flow = paymentFlow(selectedPaymentMethod, saveAfter);

  const hasDefaultPM = hasDefaultPaymentMethod(stripeCustomerFetched, currentUser);
  const defaultPMId = hasDefaultPM
    ? currentUser?.stripeCustomer?.defaultPaymentMethod?.attributes?.stripePaymentMethodId
    : null;

  const userActionsDone =
    paymentIntent && STRIPE_PI_USER_ACTIONS_DONE_STATUSES.includes(paymentIntent.status);

  const requestPaymentParams = {
    pageData,
    speculatedTransaction,
    stripe,
    card,
    billingDetails: getBillingDetails(formValues, currentUser),
    message,
    paymentIntent,
    hasPaymentIntentUserActionsDone: userActionsDone,
    stripePaymentMethodId: defaultPMId,
    process,
    onInitiateOrder,
    onConfirmCardPayment,
    onConfirmPayment,
    onSendMessage,
    onSavePaymentMethod,
    sessionStorageKey,
    stripeCustomer: currentUser?.stripeCustomer,
    isPaymentFlowUseSavedCard: flow === 'USE_SAVED_CARD',
    isPaymentFlowPayAndSaveCard: flow === 'PAY_AND_SAVE_FOR_LATER_USE',
    setPageData,
  };

  const shippingDetails = getShippingDetailsMaybe(formValues);
  const optionalPaymentParams =
    flow === 'USE_SAVED_CARD' && hasDefaultPM
      ? { paymentMethod: defaultPMId }
      : flow === 'PAY_AND_SAVE_FOR_LATER_USE'
      ? { setupPaymentMethodForSaving: true }
      : {};

  const orderParams = getOrderParams(pageData, shippingDetails, optionalPaymentParams, config);

  processCheckoutWithPayment(orderParams, requestPaymentParams)
    .then(({ orderId, messageSuccess, paymentMethodSaved }) => {
      setSubmitting(false);

      const initialMessageFailedToTransaction = messageSuccess ? null : orderId;
      const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, {
        id: orderId.uuid,
      });

      setOrderPageInitialValues(
        { initialMessageFailedToTransaction, savePaymentMethodFailed: !paymentMethodSaved },
        routeConfiguration,
        props.dispatch
      );

      onSubmitCallback();
      props.history.push(orderDetailsPath);
    })
    .catch(err => {
      console.error(err);
      setSubmitting(false);
    });
};

const onStripeInitialized = (stripe, process, props) => {
  const { paymentIntent, onRetrievePaymentIntent, pageData } = props;
  const tx = pageData?.transaction || null;

  const shouldFetchPI =
    stripe &&
    !paymentIntent &&
    tx?.id &&
    process?.getState(tx) === process?.states.PENDING_PAYMENT &&
    !hasPaymentExpired(tx, process);

  if (shouldFetchPI) {
    const { stripePaymentIntentClientSecret } =
      tx.attributes.protectedData?.stripePaymentIntents?.default || {};
    onRetrievePaymentIntent({ stripe, stripePaymentIntentClientSecret });
  }
};

// ---------- submit Cash (Final Form) ----------
const handleSubmitCash = async (values, props, setSubmitting) => {
  const { routeConfiguration, history, pageData, config, onInitiateOrder, onSubmitCallback } =
    props;

  setSubmitting(true);
  try {
    const orderParams = getOrderParams(pageData, {}, {}, config);
    orderParams.protectedData = {
      ...(orderParams.protectedData || {}),
      paymentMethod: 'cash',
      billingDetails: {
        name: values.name,
        email: values.email,
        addressLine1: values.addressLine1,
        city: values.city,
        postalCode: values.postalCode,
        country: values.country,
        note: values.note || '',
      },
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

// ---------- small subcomponent : pickup location ----------
const PickupLocation = ({ deliveryMethod, listingLocation }) => {
  if (deliveryMethod !== 'pickup' || !listingLocation) return null;
  const { address, city, postalCode, country } = listingLocation || {};
  const line = [address, city, postalCode, country].filter(Boolean).join(', ');
  return (
    <div className={css.pickupLocation}>
      <H4 className={css.subHeading}>Lieu de l’objet</H4>
      <div className={css.pickupAddress}>{line}</div>
    </div>
  );
};

// ---------- main component ----------
export const CheckoutPageWithPayment = props => {
  const [submitting, setSubmitting] = useState(false);
  const [stripe, setStripe] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('stripe'); // 'stripe' | 'cash'

  const {
    scrollingDisabled,
    speculateTransactionError,
    speculatedTransaction: speculatedTxMaybe,
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

  const isCash = paymentMethod === 'cash';

  const listingNotFound =
    isTransactionInitiateListingNotFoundError(speculateTransactionError) ||
    isTransactionInitiateListingNotFoundError(initiateOrderError);

  const { listing, transaction, orderData } = pageData;
  const existingTx = ensureTransaction(transaction);
  const speculatedTx = ensureTransaction(speculatedTxMaybe, {}, null);

  const tx =
    existingTx?.attributes?.lineItems?.length > 0 ? existingTx : speculatedTx;

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

  const totalPrice = tx?.attributes?.lineItems?.length > 0 ? getFormattedTotalPrice(tx, intl) : null;

  const process = processName ? getProcess(processName) : null;
  const transitions = process.transitions;
  const isExpired = hasPaymentExpired(existingTx, process, isClockInSync);

  const canShowForm =
    !!currentUser &&
    !listingNotFound &&
    !initiateOrderError &&
    !speculateTransactionError &&
    !retrievePaymentIntentError &&
    !isExpired;

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
    isExpired,
    retrievePaymentIntentError,
    speculateTransactionError,
    listingLink
  );

  const txTransitions = existingTx?.attributes?.transitions || [];
  const hasInquire = txTransitions.find(tr => tr.transition === transitions.INQUIRE);
  const showInitialMessageInput = !hasInquire;

  // Stripe helpers
  const userName = currentUser?.attributes?.profile
    ? `${currentUser.attributes.profile.firstName} ${currentUser.attributes.profile.lastName}`
    : null;
  const userActionsDone =
    paymentIntent && STRIPE_PI_USER_ACTIONS_DONE_STATUSES.includes(paymentIntent.status);

  const askShippingDetails =
    orderData?.deliveryMethod === 'shipping' &&
    !hasTransactionPassedPendingPayment(existingTx, process);

  // Currency: bypass check when cash
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
            {errorMessages.retrievePaymentIntentErrorMessage}
            {errorMessages.paymentExpiredMessage}

            {/* ----- Lieu de l'objet (toujours visible) ----- */}
            <PickupLocation
              deliveryMethod={orderData?.deliveryMethod}
              listingLocation={listing?.attributes?.publicData?.location}
            />

            {/* ----- Rubrique Paiement ----- */}
            <H4 className={css.subHeading}>Paiement</H4>

            {/* Sélecteur placé DANS la rubrique Paiement */}
            <div className={css.paymentMethodSection}>
              <label className={css.radioLabel}>
                <input
                  type="radio"
                  name="pm"
                  value="stripe"
                  checked={!isCash}
                  onChange={() => setPaymentMethod('stripe')}
                />
                <span>Carte (Stripe)</span>
              </label>
              <label className={css.radioLabel}>
                <input
                  type="radio"
                  name="pm"
                  value="cash"
                  checked={isCash}
                  onChange={() => setPaymentMethod('cash')}
                />
                <span>Espèces à la remise</span>
              </label>
            </div>

            {/* ----- Contenu conditionnel Stripe / Cash (tout le reste reste visible) ----- */}
            {canShowForm ? (
              isCash ? (
                // === CASH : même DS (Final Form) ; on ne cache QUE Stripe ===
                <FinalForm
                  className={css.paymentForm}
                  onSubmit={values =>
                    handleSubmitCash(values, { ...props, routeConfiguration, history }, setSubmitting)
                  }
                  render={({ handleSubmit, submitting: ffSubmitting, invalid, values }) => {
                    const disabled =
                      ffSubmitting ||
                      submitting ||
                      invalid ||
                      !values?.name ||
                      !values?.email ||
                      !values?.addressLine1 ||
                      !values?.city ||
                      !values?.postalCode ||
                      !values?.country;

                    return (
                      <form onSubmit={handleSubmit} className={css.cashBox}>
                        {/* Détails de facturation – identiques */}
                        <div className={css.formGrid}>
                          <FieldTextInput
                            id="bd-name"
                            name="name"
                            type="text"
                            label="Nom du titulaire"
                            initialValue={
                              currentUser?.attributes?.profile
                                ? `${currentUser.attributes.profile.firstName} ${currentUser.attributes.profile.lastName}`
                                : ''
                            }
                            required
                          />
                          <FieldTextInput
                            id="bd-email"
                            name="email"
                            type="email"
                            label="Email"
                            initialValue={currentUser?.attributes?.email || ''}
                            required
                          />
                          <FieldTextInput id="bd-address" name="addressLine1" type="text" label="Adresse" required />
                          <FieldTextInput id="bd-city" name="city" type="text" label="Ville" required />
                          <FieldTextInput id="bd-postal" name="postalCode" type="text" label="Code postal" required />
                          <FieldTextInput id="bd-country" name="country" type="text" label="Pays" required />
                        </div>

                        <FieldTextArea id="bd-note" name="note" label="Informations additionnelles" rows={3} />

                        <PrimaryButton className={css.submitButton} type="submit" disabled={disabled}>
                          {submitting ? 'Envoi…' : 'Demander en espèces'}
                        </PrimaryButton>
                      </form>
                    );
                  }}
                />
              ) : (
                // === STRIPE : bloc Stripe affiché ; le reste de la page reste visible ===
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
                  hasHandledCardPayment={userActionsDone}
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
