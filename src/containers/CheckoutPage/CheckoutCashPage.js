import React, { useState } from 'react';

// i18n & utils
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { propTypes } from '../../util/types';
import { createSlug } from '../../util/urlHelpers';

// Components (on ne garde que des imports sûrs)
import { Page, H3, Button, NamedLink } from '../../components';

// Helpers partagés avec la page carte
import {
  bookingDatesMaybe,
  getShippingDetailsMaybe,
  getTransactionTypeData,
} from './CheckoutPageTransactionHelpers.js';

import CustomTopbar from './CustomTopbar';
import css from './CheckoutPage.module.css';

// -----------------------------------------------------
// 1) Préchargement pour le mode CASH
// Ici on ne fait volontairement RIEN pour éviter tout crash.
// CheckoutPage appelle cette fonction → elle est "no-op" donc safe.
// -----------------------------------------------------
export const loadInitialDataForCashPayments = () => {
  // no-op volontairement :
  // pas de speculation de transaction, pas de getProcess, rien qui puisse planter.
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
    // simple marqueur côté back pour différencier
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
    showListingImage, // on ne l'utilise pas ici mais on le garde pour compat
    onInitiateOrder,
    onSubmitCallback,
  } = props;

  const [submitting, setSubmitting] = useState(false);

  const listing = pageData?.listing;
  const firstImage = listing?.images?.[0] || null;

  const handleConfirmCash = async () => {
    if (submitting) return;
    setSubmitting(true);

    try {
      const orderParams = buildOrderParams(pageData, config);

      // On force l'alias du process CASH
      const processAlias = 'reloue-booking-cash/release-1';

      // Transition générique (doit exister côté process cash)
      const transitionName = 'transition/request-payment';

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
};

export default CheckoutCashPage;
