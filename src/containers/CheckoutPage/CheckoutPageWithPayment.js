import React, { useState } from 'react';

// Util & intl
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
  PrimaryButton,
  FieldTextInput,
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

// Layout bits
import CustomTopbar from './CustomTopbar';
import StripePaymentForm from './StripePaymentForm/StripePaymentForm';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import css from './CheckoutPage.module.css';

// Stripe statuses where user action is already done
const STRIPE_PI_USER_ACTIONS_DONE_STATUSES = ['processing', 'requires_capture', 'succeeded'];

// Flow helpers for Stripe
const ONETIME_PAYMENT = 'ONETIME_PAYMENT';
const PAY_AND_SAVE_FOR_LATER_USE = 'PAY_AND_SAVE_FOR_LATER_USE';
const USE_SAVED_CARD = 'USE_SAVED_CARD';

const paymentFlow = (selectedPaymentMethod, saveAfterOnetimePayment) =>
  selectedPaymentMethod === 'defaultCard'
    ? USE_SAVED_CARD
    : saveAfterOnetimePayment
    ? PAY_AND_SAVE_FOR_LATER_USE
    : ONETIME_PAYMENT;

// ---- CASH process constants
const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';
const INITIAL_TRANSITION_CASH = 'transition/request';

// Small utils
const capitalizeString = s => `${s.charAt(0).toUpperCase()}${s.substr(1)}`;

/** Prefix chosen price variant properties under protectedData */
const prefixPriceVariantProperties = priceVariant => {
  if (!priceVariant) return {};
  const entries = Object.entries(priceVariant).map(([key, value]) => [
    `priceVariant${capitalizeString(key)}`,
    value,
  ]);
  return Object.fromEntries(entries);
};

/** Build order params for speculate + real transitions */
const getOrderParams = (pageData, shippingDetails, optionalPaymentParams, config) => {
  const quantity = pageData.orderData?.quantity;
  const seats = pageData.orderData?.seats;
  const deliveryMethod = pageData.orderData?.deliveryMethod;
  const { listingType, unitType, priceVariants } = pageData?.listing?.attributes?.publicData || {};

  const priceVariantName = pageData.orderData?.priceVariantName;
  const priceVariant = priceVariants?.find(pv => pv.name === priceVariantName);

  const protectedDataMaybe = {
    protectedData: {
      ...getTransactionTypeData(listingType, unitType, config),
      ...(deliveryMethod ? { deliveryMethod } : {}),
      ...shippingDetails,
      ...(priceVariant ? prefixPriceVariantProperties(priceVariant) : {}),
    },
  };

  return {
    listingId: pageData?.listing?.id,
    ...(deliveryMethod ? { deliveryMethod } : {}),
    ...(quantity ? { quantity } : {}),
    ...(seats ? { seats } : {}),
    ...bookingDatesMaybe(pageData.orderData?.bookingDates),
    ...(priceVariantName ? { priceVariantName } : {}),
    ...protectedDataMaybe,
    ...optionalPaymentParams,
  };
};

/** Speculate helper (unchanged behaviour) */
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

// (We keep this named export available if your parent import still references it)
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

// ===== Component
export const CheckoutPageWithPayment = props => {
  const [submitting, setSubmitting] = useState(false);
  const [stripe, setStripe] = useState(null);

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
    // new: controlled payment choice (provided by parent CheckoutPage)
    paymentMethod = 'stripe',
    onChangePaymentMethod,
    routeConfiguration,
    history,
    onInitiateOrder,
    onSubmitCallback,
  } = props;

  const isCash = paymentMethod === 'cash';

  // Handle listing / tx / breakdown
  const listing = pageData?.listing;
  const transaction = pageData?.transaction;
  const orderData = pageData?.orderData;

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
  const isPaymentExpired = hasPaymentExpired(existingTransaction, process, isClockInSync);

  const listingNotFound =
    isTransactionInitiateListingNotFoundError(speculateTransactionError) ||
    isTransactionInitiateListingNotFoundError(initiateOrderError);

  const showPaymentForm =
    !!currentUser &&
    !listingNotFound &&
    !initiateOrderError &&
    !speculateTransactionError &&
    !retrievePaymentIntentError &&
    !isPaymentExpired;

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

  // Prefill names for Stripe form
  const userName = currentUser?.attributes?.profile
    ? `${currentUser.attributes.profile.firstName} ${currentUser.attributes.profile.lastName}`
    : null;

  const hasPaymentIntentUserActionsDone =
    paymentIntent && STRIPE_PI_USER_ACTIONS_DONE_STATUSES.includes(paymentIntent.status);

  const initialValuesForStripePayment = { name: userName, recipientName: userName };
  const askShippingDetails =
    orderData?.deliveryMethod === 'shipping' &&
    !hasTransactionPassedPendingPayment(existingTransaction, process);

  // Currency guard: allow non-Stripe currencies only for cash
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

  // ---- CASH submit: same form fields, no Stripe
  const handleSubmitCash = async formValues => {
    if (submitting) return;
    try {
      setSubmitting(true);

      const shippingDetails = {}; // keep empty unless you pass address for shipping
      const optionalPaymentParams = {};
      const orderParams = getOrderParams(pageData, shippingDetails, optionalPaymentParams, config);

      // mark payment method for BO/analytics if needed
      orderParams.protectedData = {
        ...(orderParams.protectedData || {}),
        paymentMethod: 'cash',
        cashPayerName: formValues?.name || '',
        cashPayerEmail: formValues?.email || '',
        cashPayerAddressLine1: formValues?.addressLine1 || '',
        cashPayerCity: formValues?.city || '',
        cashPayerPostal: formValues?.postalCode || '',
        cashPayerCountry: formValues?.country || '',
        noteToProvider: formValues?.note || '',
      };

      const res = await onInitiateOrder(
        orderParams,
        CASH_PROCESS_ALIAS,
        null,
        INITIAL_TRANSITION_CASH,
        true
      );

      const created =
        res?.payload?.data || res?.data || res; // depending on thunk wrapper

      const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, {
        id: created.id.uuid,
      });

      setSubmitting(false);
      onSubmitCallback && onSubmitCallback();
      history.push(orderDetailsPath);
    } catch (err) {
      console.error(err);
      setSubmitting(false);
    }
  };

  // Local controlled radio handler
  const setMethod = m => {
    if (typeof onChangePaymentMethod === 'function') onChangePaymentMethod(m);
  };

  // ----- RENDER
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
          {/* Page heading */}
          <H3 as="h1" className={css.heading}>{title}</H3>

          {/* Breakdown mobile */}
          <MobileOrderBreakdown
            speculateTransactionErrorMessage={errorMessages.speculateTransactionErrorMessage}
            breakdown={breakdown}
            priceVariantName={priceVariantName}
          />

          {/* ---- Lieu de l'objet */}
          <section className={css.section}>
            <H4 className={css.subHeading}>
              <FormattedMessage id="CheckoutPage.pickupLocation" defaultMessage="Lieu de l'objet" />
            </H4>
            <div className={css.locationBox}>
              {listing?.attributes?.publicData?.location ||
                <FormattedMessage id="CheckoutPage.noLocation" defaultMessage="Adresse non renseignée" />}
            </div>
          </section>

          {/* ---- Section Paiement (avec le choix ici) */}
          <section className={css.paymentContainer}>
            {errorMessages.initiateOrderErrorMessage}
            {errorMessages.listingNotFoundErrorMessage}
            {errorMessages.speculateErrorMessage}
            {errorMessages.retrievePaymentIntentErrorMessage}
            {errorMessages.paymentExpiredMessage}

            <H4 className={css.subHeading}>
              <FormattedMessage id="CheckoutPage.payment" defaultMessage="Paiement" />
            </H4>

            {/* Choix Carte / Espèces */}
            <div className={css.paymentMethodRow}>
              <label className={css.radioLabel}>
                <input
                  type="radio"
                  name="paymentMethod"
                  value="stripe"
                  checked={!isCash}
                  onChange={() => setMethod('stripe')}
                />
                <span>
                  <FormattedMessage defaultMessage="Carte (Stripe)" />
                </span>
              </label>
              <label className={css.radioLabel}>
                <input
                  type="radio"
                  name="paymentMethod"
                  value="cash"
                  checked={isCash}
                  onChange={() => setMethod('cash')}
                />
                <span>
                  <FormattedMessage defaultMessage="Espèces à la remise" />
                </span>
              </label>
            </div>

            {/* Bloc STRIPE : visible uniquement si Carte */}
            {showPaymentForm && !isCash ? (
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
                onStripeInitialized={stripeInstance => {
                  setStripe(stripeInstance);
                  return onStripeInitialized(stripeInstance, process, props);
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
            ) : null}
          </section>

          {/* ---- Coordonnées de facturation : TOUJOURS visibles */}
          <section className={css.section}>
            <H4 className={css.subHeading}>
              <FormattedMessage defaultMessage="Détails de facturation" />
            </H4>

            {/* Form final : sert à SOUMETTRE quand on est en CASH.
                Quand Carte, ce form est juste affiché (Stripe soumet de son côté). */}
            <BillingForm
              submitting={submitting}
              isCash={isCash}
              currentUser={currentUser}
              onSubmitCash={handleSubmitCash}
            />
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

/** Billing form: always rendered. Submits only in cash mode. */
const BillingForm = ({ submitting, isCash, currentUser, onSubmitCash }) => {
  const [values, setValues] = useState(() => ({
    name: currentUser?.attributes?.profile
      ? `${currentUser.attributes.profile.firstName} ${currentUser.attributes.profile.lastName}`
      : '',
    email: currentUser?.attributes?.email || '',
    addressLine1: '',
    city: '',
    postalCode: '',
    country: '',
    note: '',
  }));

  const onChange = e => setValues(v => ({ ...v, [e.target.name]: e.target.value }));

  const submit = e => {
    e.preventDefault();
    if (isCash) onSubmitCash(values);
  };

  return (
    <form className={css.billingForm} onSubmit={submit}>
      <div className={css.formGrid}>
        <FieldTextInput
          id="bd-name"
          name="name"
          type="text"
          label="Nom du titulaire"
          value={values.name}
          onChange={onChange}
          required
        />
        <FieldTextInput
          id="bd-email"
          name="email"
          type="email"
          label="Email"
          value={values.email}
          onChange={onChange}
          required
        />
        <FieldTextInput
          id="bd-address"
          name="addressLine1"
          type="text"
          label="Adresse"
          value={values.addressLine1}
          onChange={onChange}
          required
        />
        <FieldTextInput
          id="bd-city"
          name="city"
          type="text"
          label="Ville"
          value={values.city}
          onChange={onChange}
          required
        />
        <FieldTextInput
          id="bd-postal"
          name="postalCode"
          type="text"
          label="Code postal"
          value={values.postalCode}
          onChange={onChange}
          required
        />
        <FieldTextInput
          id="bd-country"
          name="country"
          type="text"
          label="Pays"
          value={values.country}
          onChange={onChange}
          required
        />
      </div>

      <H4 className={css.subHeading} style={{ marginTop: 16 }}>
        Informations additionnelles
      </H4>
      <FieldTextInput
        id="bd-note"
        name="note"
        type="text"
        label="Message au propriétaire (optionnel)"
        value={values.note}
        onChange={onChange}
      />

      {isCash ? (
        <PrimaryButton className={css.submitButton} type="submit" inProgress={submitting}>
          Demander en espèces
        </PrimaryButton>
      ) : null}
    </form>
  );
};

CheckoutPageWithPayment.defaultProps = {
  paymentMethod: 'stripe',
  onChangePaymentMethod: () => {},
};

CheckoutPageWithPayment.propTypes = {
  scrollingDisabled: propTypes.bool.isRequired,
  speculateTransactionError: propTypes.error,
  speculatedTransaction: propTypes.transaction,
  isClockInSync: propTypes.bool,
  initiateOrderError: propTypes.error,
  confirmPaymentError: propTypes.error,
  intl: intlShape.isRequired,
  currentUser: propTypes.currentUser,
  confirmCardPaymentError: propTypes.error,
  paymentIntent: propTypes.paymentIntent,
  retrievePaymentIntentError: propTypes.error,
  stripeCustomerFetched: propTypes.bool,
  pageData: propTypes.object.isRequired,
  processName: propTypes.string,
  listingTitle: propTypes.string,
  title: propTypes.string.isRequired,
  config: propTypes.object.isRequired,
  paymentMethod: propTypes.string,
  onChangePaymentMethod: propTypes.func,
};

export default CheckoutPageWithPayment;
