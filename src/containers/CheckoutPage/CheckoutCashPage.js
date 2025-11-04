import React, { useState } from 'react';

// Import contexts & utils (mêmes chemins que CheckoutPageWithPayment)
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { propTypes } from '../../util/types';
import { ensureTransaction } from '../../util/data';
import { createSlug } from '../../util/urlHelpers';
import { getProcess, isBookingProcessAlias } from '../../transactions/transaction';

// Shared components
import { H3, H4, NamedLink, OrderBreakdown, Page } from '../../components';

// Helpers communs à Checkout
import {
  bookingDatesMaybe,
  getFormattedTotalPrice,
  getTransactionTypeData,
} from './CheckoutPageTransactionHelpers.js';
import { getErrorMessages } from './ErrorMessages';

import CustomTopbar from './CustomTopbar';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import css from './CheckoutPage.module.css';

/** ====== CONSTANTES POUR CASH ====== */
const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';
const TX_REQUEST = 'transition/request';

/** ====== CONSTRUCTION DES PARAMS POUR L’INIT ======
 * (version simplifiée, sans Stripe)
 */
const getOrderParamsForCash = (pageData, config, message) => {
  const quantity = pageData?.orderData?.quantity;
  const seats = pageData?.orderData?.seats;
  const deliveryMethod = pageData?.orderData?.deliveryMethod;
  const { listingType, unitType } = pageData?.listing?.attributes?.publicData || {};

  const quantityMaybe = quantity ? { quantity } : {};
  const seatsMaybe = seats ? { seats } : {};
  const deliveryMethodMaybe = deliveryMethod ? { deliveryMethod } : {};

  // protectedData minimal pour typer le process & tracer le mode
  const protectedDataMaybe = {
    protectedData: {
      ...getTransactionTypeData(listingType, unitType, config),
      ...deliveryMethodMaybe,
      paymentMethod: 'cash',
    },
  };

  return {
    listingId: pageData?.listing?.id,
    ...deliveryMethodMaybe,
    ...quantityMaybe,
    ...seatsMaybe,
    ...bookingDatesMaybe(pageData?.orderData?.bookingDates),
    ...protectedDataMaybe,
    // facultatif : message initial
    message: message || '',
  };
};

/** ====== PAGE CASH (sans Stripe) ====== */
const CheckoutCashPage = props => {
  const {
    // fournis par CheckoutPage.js (container parent)
    scrollingDisabled,
    speculateTransactionError,
    speculatedTransaction: speculatedTransactionMaybe,
    isClockInSync, // pas utilisé ici mais laissé pour cohérence de props
    initiateOrderError,
    intl,
    currentUser, // pas obligatoire ici
    showListingImage,
    pageData,
    processName,
    listingTitle,
    title,
    config,
    routeConfiguration,
    history,
    onInitiateOrder,
  } = props;

  const [submitting, setSubmitting] = useState(false);
  const [initialMessage, setInitialMessage] = useState('');

  // Entities & données (même logique que CheckoutPageWithPayment)
  const { listing, transaction } = pageData;
  const existingTransaction = ensureTransaction(transaction);
  const speculatedTransaction = ensureTransaction(speculatedTransactionMaybe, {}, null);

  // Si on a déjà un tx avec lineItems, on l’utilise, sinon on s’appuie sur la speculée
  const tx =
    existingTransaction?.attributes?.lineItems?.length > 0
      ? existingTransaction
      : speculatedTransaction;

  const timeZone = listing?.attributes?.availabilityPlan?.timezone;
  const transactionProcessAlias = listing?.attributes?.publicData?.transactionProcessAlias;

  const txBookingMaybe = tx?.booking?.id ? { booking: tx.booking, timeZone } : {};

  // Breakdown uniquement si on a un tx (id + lineItems)
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
  const firstImage = listing?.images?.length > 0 ? listing.images[0] : null;

  const listingLink = (
    <NamedLink
      name="ListingPage"
      params={{ id: listing?.id?.uuid, slug: createSlug(listingTitle) }}
    >
      <FormattedMessage id="CheckoutPage.errorlistingLinkText" />
    </NamedLink>
  );

  // On réutilise les mêmes messages d’erreur “généraux”
  const errorMessages = getErrorMessages(
    /* listingNotFound: */ false,
    initiateOrderError,
    /* isPaymentExpired: */ false,
    /* retrievePaymentIntentError: */ null,
    speculateTransactionError,
    listingLink
  );

  const goBackToChoice = () => {
    history.replace(
      pathByRouteName('CheckoutPage', routeConfiguration, {
        id: listing?.id?.uuid,
        slug: createSlug(listingTitle),
      })
    );
  };

  const onSubmit = e => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    try {
      const orderParams = getOrderParamsForCash(pageData, config, initialMessage);
      const transactionId = existingTransaction?.id || null;

      onInitiateOrder(orderParams, CASH_PROCESS_ALIAS, transactionId, TX_REQUEST, /*priv*/ false)
        .then(order => {
          const orderId = order?.id?.uuid || order?.uuid || order?.data?.data?.id?.uuid;
          if (orderId) {
            const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, {
              id: orderId,
            });
            history.push(orderDetailsPath);
          } else {
            // fallback listing
            history.push(
              pathByRouteName('ListingPage', routeConfiguration, {
                id: listing?.id?.uuid,
                slug: createSlug(listingTitle),
              })
            );
          }
        })
        .catch(err => {
          // eslint-disable-next-line no-console
          console.error('cash initiate failed', err);
        })
        .finally(() => setSubmitting(false));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cash submit error', err);
      setSubmitting(false);
    }
  };

  const titleToShow =
    title ||
    intl.formatMessage(
      { id: 'CheckoutCashPage.title', defaultMessage: 'Demande de location (espèces)' },
      { listingTitle }
    );

  const priceVariantName = tx?.attributes?.protectedData?.priceVariantName;
  const isBooking = isBookingProcessAlias(transactionProcessAlias);

  return (
    <Page title={titleToShow} scrollingDisabled={scrollingDisabled}>
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
          {/* Bouton pour revenir au choix du mode de paiement */}
          <div style={{ marginBottom: 12 }}>
            <button type="button" className="buttonSecondary" onClick={goBackToChoice}>
              <FormattedMessage id="CheckoutPage.changePayment" defaultMessage="⟵ Changer de mode de paiement" />
            </button>
          </div>

          <div className={css.headingContainer}>
            <H3 as="h1" className={css.heading}>
              {titleToShow}
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
            {/* messages d’erreur “généraux” */}
            {errorMessages.initiateOrderErrorMessage}
            {errorMessages.speculateErrorMessage}

            {/* Formulaire minimal : message au propriétaire */}
            <form className={css.paymentForm} onSubmit={onSubmit}>
              <div className={css.field}>
                <label className={css.label}>
                  <FormattedMessage
                    id="CheckoutCashPage.messageLabel"
                    defaultMessage="Message au propriétaire (optionnel)"
                  />
                </label>
                <textarea
                  className={css.textarea}
                  rows={4}
                  value={initialMessage}
                  onChange={e => setInitialMessage(e.target.value)}
                  placeholder={intl.formatMessage({
                    id: 'CheckoutCashPage.messagePlaceholder',
                    defaultMessage:
                      'Infos utiles (horaires, remise en main propre, précision sur l’usage, etc.)',
                  })}
                />
              </div>

              <div className={css.submitWrapper}>
                <button className="button" type="submit" disabled={submitting}>
                  {submitting ? (
                    <FormattedMessage id="CheckoutCashPage.sending" defaultMessage="Envoi..." />
                  ) : (
                    <FormattedMessage id="CheckoutCashPage.submit" defaultMessage="Envoyer la demande" />
                  )}
                </button>
              </div>

              {/* Petit rappel process espèces */}
              <p className={css.helperText} style={{ marginTop: 8 }}>
                <FormattedMessage
                  id="CheckoutCashPage.helper"
                  defaultMessage="Aucune carte ne sera demandée. Les dates seront bloquées après validation par le propriétaire."
                />
              </p>
            </form>
          </section>
        </div>

        {/* Colonne droite comme sur la page carte */}
        <DetailsSideCard
          listing={listing}
          listingTitle={listingTitle}
          priceVariantName={priceVariantName}
          author={listing?.author}
          firstImage={firstImage}
          layoutListingImageConfig={config.layout.listingImage}
          speculateTransactionErrorMessage={errorMessages.speculateTransactionErrorMessage}
          isInquiryProcess={false}
          processName={'reloue-booking-cash'}
          breakdown={breakdown}
          showListingImage={showListingImage}
          intl={intl}
          totalPrice={totalPrice}
          isBooking={isBooking}
        />
      </div>
    </Page>
  );
};

CheckoutCashPage.defaultProps = {
  speculatedTransaction: null,
  listingTitle: '',
  title: null,
  currentUser: null,
};

CheckoutCashPage.propTypes = {
  scrollingDisabled: propTypes.bool.isRequired,
  speculateTransactionError: propTypes.error,
  speculatedTransaction: propTypes.tx,
  isClockInSync: propTypes.bool,
  initiateOrderError: propTypes.error,
  intl: propTypes.intl.isRequired,
  currentUser: propTypes.currentUser,
  showListingImage: propTypes.bool,
  pageData: propTypes.shape({
    listing: propTypes.listing,
    transaction: propTypes.tx,
    orderData: propTypes.object,
  }).isRequired,
  processName: propTypes.string,
  listingTitle: propTypes.string,
  title: propTypes.string,
  config: propTypes.object.isRequired,
  routeConfiguration: propTypes.object.isRequired,
  history: propTypes.history.isRequired,
  onInitiateOrder: propTypes.func.isRequired,
};

export default CheckoutCashPage;
