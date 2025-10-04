import React, { useState } from 'react';

// Import contexts and util modules
import { FormattedMessage, intlShape } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { isValidCurrencyForTransactionProcess } from '../../util/fieldHelpers.js';
import { propTypes } from '../../util/types';
import { ensureTransaction } from '../../util/data';
import { createSlug } from '../../util/urlHelpers';
import { isTransactionInitiateListingNotFoundError } from '../../util/errors';
import { getProcess, isBookingProcessAlias } from '../../transactions/transaction';

// Import shared components
import {
  H3,
  H4,
  NamedLink,
  OrderBreakdown,
  Page,
  PrimaryButton,
  FieldRadioButton,
  FieldTextInput,
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

// Stripe PaymentIntent statuses
const STRIPE_PI_USER_ACTIONS_DONE_STATUSES = ['processing', 'requires_capture', 'succeeded'];

// Payment charge options
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

const prefixPriceVariantProperties = priceVariant => {
  if (!priceVariant) return {};
  const entries = Object.entries(priceVariant).map(([key, value]) => {
    return [`priceVariant${capitalizeString(key)}`, value];
  });
  return Object.fromEntries(entries);
};

const getOrderParams = (pageData, shippingDetails, optionalPaymentParams, config) => {
  const quantity = pageData.orderData?.quantity;
  const quantityMaybe = quantity ? { quantity } : {};
  const seats = pageData.orderData?.seats;
  const seatsMaybe = seats ? { seats } : {};
  const deliveryMethod = pageData.orderData?.deliveryMethod;
  const deliveryMethodMaybe = deliveryMethod ? { deliveryMethod } : {};
  const { listingType, unitType, priceVariants } = pageData?.listing?.attributes?.publicData || {};

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

// Loader spécifique Stripe
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

// Constantes pour le process CASH
const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';
const INITIAL_TRANSITION_CASH = 'transition/request';

/** --- Composants UI --- **/

// Sélecteur du mode de paiement
const PaymentMethodSelector = ({ value, onChange }) => (
  <div className={css.paymentMethodSection}>
    <H3 as="h2" className={css.sectionTitle}>
      <FormattedMessage id="CheckoutPage.paymentMethod.title" defaultMessage="Mode de paiement" />
    </H3>
    <div className={css.radioRow}>
      <FieldRadioButton
        id="pm-stripe"
        name="paymentMethod"
        value="stripe"
        label="Carte (Stripe)"
        checked={value === 'stripe'}
        onChange={() => onChange('stripe')}
      />
      <FieldRadioButton
        id="pm-cash"
        name="paymentMethod"
        value="cash"
        label="Espèces à la remise"
        checked={value === 'cash'}
        onChange={() => onChange('cash')}
      />
    </div>
    <p className={css.paymentHelp}>
      {value === 'cash'
        ? 'Vous règlerez en espèces lors de la remise. Aucun prélèvement en ligne.'
        : "Paiement sécurisé par Stripe. Vos informations de carte ne sont jamais stockées par RELOUE."}
    </p>
  </div>
);

// Formulaire simplifié des coordonnées de facturation (pour CASH)
const BillingDetailsForm = ({ initial, onSubmit, inProgress }) => {
  const [values, setValues] = useState({
    name: initial?.name || '',
    email: initial?.email || '',
    addressLine1: initial?.addressLine1 || '',
    city: initial?.city || '',
    postalCode: initial?.postalCode || '',
    country: initial?.country || '',
  });

  const onChange = (key, val) => setValues(v => ({ ...v, [key]: val }));

  const canSubmit =
    values.name &&
    values.email &&
    values.addressLine1 &&
    values.city &&
    values.postalCode &&
    values.country;

  return (
    <div className={css.cashBox}>
      <H4 className={css.sectionTitle}>Coordonnées de facturation</H4>
      <div className={css.formGrid}>
        <FieldTextInput
          id="bd-name"
          name="bd-name"
          type="text"
          label="Nom complet"
          value={values.name}
          onChange={e => onChange('name', e.target.value)}
          required
        />
        <FieldTextInput
          id="bd-email"
          name="bd-email"
          type="email"
          label="Email"
          value={values.email}
          onChange={e => onChange('email', e.target.value)}
          required
        />
        <FieldTextInput
          id="bd-address"
          name="bd-address"
          type="text"
          label="Adresse"
          value={values.addressLine1}
          onChange={e => onChange('addressLine1', e.target.value)}
          required
        />
        <FieldTextInput
          id="bd-city"
          name="bd-city"
          type="text"
          label="Ville"
          value={values.city}
          onChange={e => onChange('city', e.target.value)}
          required
        />
        <FieldTextInput
          id="bd-postal"
          name="bd-postal"
          type="text"
          label="Code postal"
          value={values.postalCode}
          onChange={e => onChange('postalCode', e.target.value)}
          required
        />
        <FieldTextInput
          id="bd-country"
          name="bd-country"
          type="text"
          label="Pays"
          placeholder="FR"
          value={values.country}
          onChange={e => onChange('country', e.target.value)}
          required
        />
      </div>

      <PrimaryButton
        className={css.submitButton}
        type="button"
        onClick={() => onSubmit(values)}
        inProgress={inProgress}
        disabled={inProgress || !canSubmit}
      >
        {inProgress ? 'Envoi…' : 'Demander en espèces'}
      </PrimaryButton>
    </div>
  );
};

/** --- Logique paiement Stripe --- **/
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

/** --- Page --- **/
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
    paymentMethod = 'stripe',
    routeConfiguration,
    history,
    onChangePaymentMethod,
  } = props;

  const isCash = paymentMethod === 'cash';

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
  const transitions = process?.transitions || {};
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

  // si CASH, on ne bloque pas sur la compatibilité Stripe
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

  // Soumission CASH (initiate + stockage billingDetails)
  const handleSubmitCash = async billingValues => {
    if (submitting) return;
    try {
      setSubmitting(true);

      const shippingDetails = {};
      const optionalPaymentParams = {};
      const orderParams = getOrderParams(pageData, shippingDetails, optionalPaymentParams, config);

      orderParams.protectedData = {
        ...(orderParams.protectedData || {}),
        paymentMethod: 'cash',
        billingDetails: billingValues,
      };

      const res = await props.onInitiateOrder(
        orderParams,
        CASH_PROCESS_ALIAS,
        null,
        INITIAL_TRANSITION_CASH,
        true
      );

      const createdTx = res?.payload?.data || res?.data || res;

      const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, {
        id: createdTx.id.uuid,
      });

      setSubmitting(false);
      props.onSubmitCallback && props.onSubmitCallback();
      history.push(orderDetailsPath);
    } catch (err) {
      console.error(err);
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

          {/* Récap / lieu / tarif mobile */}
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

            {/* ⬇️ Choix du mode de paiement – placé après le “Lieu de l’objet” */}
            <PaymentMethodSelector value={paymentMethod} onChange={onChangePaymentMethod} />

            {showPaymentForm ? (
              isCash ? (
                <BillingDetailsForm
                  initial={{ name: userName, email: currentUser?.attributes?.email }}
                  onSubmit={handleSubmitCash}
                  inProgress={submitting}
                />
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
                  onStripeInitialized={stripe => {
                    setStripe(stripe);
                    return onStripeInitialized(stripe, process, props);
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
