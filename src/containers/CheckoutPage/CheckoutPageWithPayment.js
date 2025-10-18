import React, { useState } from 'react';
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { isValidCurrencyForTransactionProcess } from '../../util/fieldHelpers.js';
import { ensureTransaction } from '../../util/data';
import { createSlug } from '../../util/urlHelpers';
import { isTransactionInitiateListingNotFoundError } from '../../util/errors';
import { getProcess, isBookingProcessAlias } from '../../transactions/transaction';

// UI Components
import {
  H3,
  H4,
  NamedLink,
  OrderBreakdown,
  Page,
  PrimaryButton,
  Form as FinalForm,
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

// Layout
import CustomTopbar from './CustomTopbar';
import StripePaymentForm from './StripePaymentForm/StripePaymentForm';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import css from './CheckoutPage.module.css';

const STRIPE_PI_USER_ACTIONS_DONE_STATUSES = ['processing', 'requires_capture', 'succeeded'];

// --- CASH process (alias/version) ---
const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';
const CASH_INITIAL_TRANSITION = 'transition/request';

// ---------- Helpers ----------
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

// ---------- CASH submit ----------
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

// ---------- subcomponent : pickup location ----------
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
    onRetrievePaymentIntent,
  } = props;

  const isCash = paymentMethod === 'cash';

  const listing = pageData?.listing;
  const existingTx = ensureTransaction(pageData.transaction);
  const tx = ensureTransaction(speculatedTxMaybe, {}, null);
  const process = processName ? getProcess(processName) : null;

  const firstImage = listing?.images?.length > 0 ? listing.images[0] : null;

  const showStripeForm =
    !!currentUser &&
    !isCash &&
    !initiateOrderError &&
    !speculateTransactionError &&
    !retrievePaymentIntentError;

  const showCashForm =
    !!currentUser &&
    isCash &&
    !initiateOrderError &&
    !speculateTransactionError;

  const totalPrice =
    tx?.attributes?.lineItems?.length > 0 ? getFormattedTotalPrice(tx, intl) : null;

  const handleStripeInitialized = stripeInstance => {
    setStripe(stripeInstance);
    const txLocal = pageData?.transaction || null;
    if (
      stripeInstance &&
      !paymentIntent &&
      txLocal?.id &&
      process?.getState(txLocal) === process?.states.PENDING_PAYMENT &&
      !hasPaymentExpired(txLocal, process)
    ) {
      const { stripePaymentIntentClientSecret } =
        txLocal.attributes.protectedData?.stripePaymentIntents?.default || {};
      onRetrievePaymentIntent({
        stripe: stripeInstance,
        stripePaymentIntentClientSecret,
      });
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
          <H3 as="h1" className={css.heading}>{title}</H3>

          {/* Lieu de l'objet */}
          <PickupLocation
            deliveryMethod={pageData.orderData?.deliveryMethod}
            listingLocation={listing?.attributes?.publicData?.location}
          />

          {/* Choix du mode de paiement */}
          <H4 className={css.subHeading}>Mode de paiement</H4>
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

          {/* Bloc Stripe (paiement par carte) */}
          {showStripeForm && (
            <StripePaymentForm
              className={css.paymentForm}
              onSubmit={values =>
                props.handleSubmitStripe(values, process, props, stripe, submitting, setSubmitting)
              }
              inProgress={submitting}
              formId="CheckoutPagePaymentForm"
              authorDisplayName={listing?.author?.attributes?.profile?.displayName}
              paymentIntent={paymentIntent}
              onStripeInitialized={handleStripeInitialized}
              totalPrice={totalPrice}
              locale={config.localization.locale}
              stripePublishableKey={config.stripe.publishableKey}
              marketplaceName={config.marketplaceName}
            />
          )}

          {/* Bloc Cash (espèces à la remise) */}
          {showCashForm && (
            <FinalForm
              onSubmit={values =>
                handleSubmitCash(values, { ...props, routeConfiguration, history }, setSubmitting)
              }
              initialValues={{
                name:
                  currentUser?.attributes?.profile
                    ? `${currentUser.attributes.profile.firstName} ${currentUser.attributes.profile.lastName}`
                    : '',
                email: currentUser?.attributes?.email || '',
              }}
              render={({ handleSubmit }) => (
                <form onSubmit={handleSubmit} className={css.cashBox}>
                  <H4 className={css.subHeading}>Détails de facturation</H4>
                  <div className={css.formGrid}>
                    <FieldTextInput id="bd-name" name="name" type="text" label="Nom du titulaire" required />
                    <FieldTextInput id="bd-email" name="email" type="email" label="Email" required />
                    <FieldTextInput id="bd-address" name="addressLine1" type="text" label="Adresse" required />
                    <FieldTextInput id="bd-city" name="city" type="text" label="Ville" required />
                    <FieldTextInput id="bd-postal" name="postalCode" type="text" label="Code postal" required />
                    <FieldTextInput id="bd-country" name="country" type="text" label="Pays" required />
                  </div>

                  <H4 className={css.subHeading} style={{ marginTop: 16 }}>
                    Informations additionnelles
                  </H4>
                  <FieldTextInput id="bd-note" name="note" type="text" label="Message au propriétaire (optionnel)" />

                  <PrimaryButton className={css.submitButton} type="submit">
                    Demander en espèces
                  </PrimaryButton>
                </form>
              )}
            />
          )}
        </div>

        <DetailsSideCard
          listing={listing}
          listingTitle={listingTitle}
          author={listing?.author}
          firstImage={firstImage}
          layoutListingImageConfig={config.layout.listingImage}
          showListingImage={showListingImage}
          intl={intl}
        />
      </div>
    </Page>
  );
};

export default CheckoutPageWithPayment;
