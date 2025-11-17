import React, { useState } from 'react';

// i18n & utils
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { propTypes } from '../../util/types';
import { createSlug } from '../../util/urlHelpers';

// Components
import { Page, H3, Button, NamedLink } from '../../components';

// Helpers partagés
import {
  bookingDatesMaybe,
  getShippingDetailsMaybe,
  getTransactionTypeData,
} from './CheckoutPageTransactionHelpers.js';

import CustomTopbar from './CustomTopbar';
import css from './CheckoutPage.module.css';

// -----------------------------------------------------
// 1) Préchargement pour le mode CASH
// (no-op pour ne rien casser si CheckoutPage l'appelle)
// -----------------------------------------------------
export const loadInitialDataForCashPayments = () => {
  // volontairement vide : pas de speculation, pas de Stripe
};

// -----------------------------------------------------
// 2) Construction des paramètres d’ordre (sans Stripe)
// -----------------------------------------------------
const buildOrderParams = (pageData, config) => {
  const listing = pageData?.listing;
  const orderData = pageData?.orderData || {};

  const quantity = orderData.quantity;
  const seats = orderData.seats;
  const deliveryMethod = orderData.deliveryMethod;

  const publicData = listing?.attributes?.publicData || {};
  const listingType = publicData.listingType;
  const unitType = publicData.unitType;

  const protectedData = {
    ...getTransactionTypeData(listingType, unitType, config),
    ...(deliveryMethod ? { deliveryMethod } : {}),
    // marqueur pour dire que le paiement se fait en espèces
    paymentMethod: 'cash',
  };

  return {
    listingId: listing?.id,
    ...(deliveryMethod ? { deliveryMethod } : {}),
    ...(quantity ? { quantity } : {}),
    ...(seats ? { seats } : {}),
    ...bookingDatesMaybe(orderData.bookingDates),
    protectedData,
    ...getShippingDetailsMaybe({}),
  };
};

// -----------------------------------------------------
// 3) Composant principal CheckoutCashPage
// -----------------------------------------------------
const CheckoutCashPage = props => {
  const {
    scrollingDisabled,
    intl,
    config,
    routeConfiguration,
    history,
    pageData,
    listingTitle,
    title,
    showListingImage, // gardé pour compatibilité, même si pas utilisé ici
    onInitiateOrder,
    onSubmitCallback,
    processName, // "reloue-booking-cash" passé par CheckoutPage (pas indispensable ici)
  } = props;

  const [submitting, setSubmitting] = useState(false);

  const listing = pageData?.listing;

  const handleConfirmCash = async () => {
    if (submitting) return;
    setSubmitting(true);

    try {
      const orderParams = buildOrderParams(pageData, config);

      // Process cash
      const processAlias = 'reloue-booking-cash/release-1';

      // ✅ transition de départ du process reloue-booking-cash :
      // initial --request--> pending-accept
      const transitionName = 'transition/request';

      const transactionId = pageData?.transaction?.id || null;
      const isPrivileged = false;

      const res = await onInitiateOrder(
        orderParams,
        processAlias,
        transactionId,
        transitionName,
        isPrivileged
      );

      const orderId =
        res?.orderId ||
        res?.data?.id ||
        res?.data?.id?.uuid ||
        res?.id ||
        res?.uuid ||
        null;

      if (orderId) {
        const idUuid = orderId.uuid ? orderId.uuid : orderId;
        const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, {
          id: idUuid,
        });
        onSubmitCallback && onSubmitCallback();
        history.push(orderDetailsPath);
      } else {
        // fallback : retour à la fiche
        onSubmitCallback && onSubmitCallback();
        history.push(`/l/${createSlug(listingTitle)}/${listing.id.uuid}`);
      }
    } catch (e) {
      console.error('CheckoutCashPage cash submit error', e);
      setSubmitting(false);
    }
  };

  const pageTitle =
    title ||
    intl.formatMessage(
      { id: 'CheckoutPage.reloue-booking-cash.title' },
      {
        listingTitle: listingTitle || '',
        authorDisplayName:
          listing?.author?.attributes?.profile?.displayName || '',
      }
    );

  return (
    <Page title={pageTitle} scrollingDisabled={scrollingDisabled}>
      <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />

      <div className={css.contentContainer}>
        <div className={css.orderFormContainer}>
          <div className={css.headingContainer}>
            <H3 as="h1" className={css.heading}>{pageTitle}</H3>
          </div>

          <section className={css.paymentContainer}>
            <p className={css.cashNotice}>
              <FormattedMessage id="CheckoutPage.payInCash.instruction" />
            </p>

            <div className={css.confirmRow}>
              <Button
                className={css.primaryButton}
                onClick={handleConfirmCash}
                disabled={submitting}
                type="button"
              >
                {submitting ? (
                  <FormattedMessage id="CheckoutPage.confirming" />
                ) : (
                  <FormattedMessage id="CheckoutPage.payInCash.confirmButton" />
                )}
              </Button>
            </div>

            <div className={css.backLinkRow}>
              <NamedLink
                name="ListingPage"
                params={{ id: listing?.id?.uuid, slug: createSlug(listingTitle) }}
              >
                ← <FormattedMessage id="CheckoutPage.backToListing" />
              </NamedLink>
            </div>
          </section>
        </div>
      </div>
    </Page>
  );
};

CheckoutCashPage.defaultProps = {
  showListingImage: true,
};

CheckoutCashPage.propTypes = {
  scrollingDisabled: propTypes.bool,
  intl: propTypes.intl.isRequired,
  config: propTypes.object.isRequired,
  routeConfiguration: propTypes.object.isRequired,
  history: propTypes.object.isRequired,
  pageData: propTypes.object.isRequired,
  listingTitle: propTypes.string,
  title: propTypes.string,
  showListingImage: propTypes.bool,
  onInitiateOrder: propTypes.func.isRequired,
  onSubmitCallback: propTypes.func.isRequired,
  processName: propTypes.string,
};

export default CheckoutCashPage;
