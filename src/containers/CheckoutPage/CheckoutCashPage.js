import React, { useState } from 'react';
import { FormattedMessage } from '../../util/reactIntl';
import { pathByRouteName } from '../../util/routes';
import { createSlug } from '../../util/urlHelpers';
import { ensureTransaction } from '../../util/data';
import { H3, H4, Page, Button, NamedLink, OrderBreakdown } from '../../components';

import CustomTopbar from './CustomTopbar';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import {
  bookingDatesMaybe,
  getShippingDetailsMaybe,
  getFormattedTotalPrice,
  getTransactionTypeData,
} from './CheckoutPageTransactionHelpers.js';

import css from './CheckoutPage.module.css';

const prefixPriceVariantProperties = priceVariant => {
  if (!priceVariant) return {};
  const cap = s => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  return Object.fromEntries(Object.entries(priceVariant).map(([k, v]) => [`priceVariant${cap(k)}`, v]));
};

const buildOrderParams = (pageData, config) => {
  const quantity = pageData.orderData?.quantity;
  const seats = pageData.orderData?.seats;
  const deliveryMethod = pageData.orderData?.deliveryMethod;

  const { listingType, unitType, priceVariants } = pageData?.listing?.attributes?.publicData || {};
  const priceVariantName = pageData.orderData?.priceVariantName;
  const priceVariant = priceVariants?.find(pv => pv.name === priceVariantName);

  const shippingDetails = getShippingDetailsMaybe({});
  const protectedData = {
    ...getTransactionTypeData(listingType, unitType, config),
    ...(deliveryMethod ? { deliveryMethod } : {}),
    ...prefixPriceVariantProperties(priceVariant),
    // ⚠️ Rien lié à Stripe ici
    paymentMethod: 'cash',
  };

  return {
    listingId: pageData?.listing?.id,
    ...(deliveryMethod ? { deliveryMethod } : {}),
    ...(quantity ? { quantity } : {}),
    ...(seats ? { seats } : {}),
    ...bookingDatesMaybe(pageData.orderData?.bookingDates),
    ...(priceVariantName ? { priceVariantName } : {}),
    protectedData,
    ...shippingDetails,
  };
};

const CheckoutCashPage = props => {
  const {
    config,
    intl,
    history,
    routeConfiguration,
    pageData,
    onInitiateOrder,
    onSubmitCallback,
    speculateTransactionInProgress,
    showListingImage,
  } = props;

  const [submitting, setSubmitting] = useState(false);

  const { listing, transaction } = pageData || {};
  const tx = ensureTransaction(transaction);
  const listingTitle = listing?.attributes?.title;
  const totalPrice = tx?.attributes?.lineItems?.length > 0 ? getFormattedTotalPrice(tx, intl) : null;

  const breakdown =
    tx?.id && tx.attributes?.lineItems?.length > 0 ? (
      <OrderBreakdown
        className={css.orderBreakdown}
        userRole="customer"
        transaction={tx}
        currency={config.currency}
        marketplaceName={config.marketplaceName}
      />
    ) : null;

  const title = intl.formatMessage(
    { id: 'CheckoutPage.reloue-booking-cash.title' },
    {
      listingTitle,
      authorDisplayName: listing?.author?.attributes?.profile?.displayName || '',
    }
  );

  const goToOrderDetails = orderId => {
    const idUuid = orderId?.uuid ? orderId.uuid : orderId;
    const orderDetailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, { id: idUuid });
    onSubmitCallback && onSubmitCallback();
    history.push(orderDetailsPath);
  };

  const handleConfirmCash = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const orderParams = buildOrderParams(pageData, config);

      // On garde l'alias de process publié sur l’annonce
      const processAlias = listing?.attributes?.publicData?.transactionProcessAlias || 'reloue-booking-cash';
      const transactionId = tx?.id || null;

      // On passe un nom de transition "request-payment" utilisé partout par défaut
      // (le process cash doit mimer cette transition côté Serve)
      const transitionName = 'transition/request-payment';
      const isPrivileged = false;

      const res = await onInitiateOrder(orderParams, processAlias, transactionId, transitionName, isPrivileged);

      const orderId =
        res?.orderId ||
        res?.data?.id ||
        res?.data?.id?.uuid ||
        res?.id ||
        res?.uuid ||
        null;

      if (orderId) {
        goToOrderDetails(orderId);
      } else {
        // fallback: retour à la fiche
        onSubmitCallback && onSubmitCallback();
        history.push(`/l/${createSlug(listingTitle)}/${listing.id.uuid}`);
      }
    } catch (e) {
      console.error('Cash checkout error', e);
      setSubmitting(false);
    }
  };

  return (
    <Page title={title} scrollingDisabled={false}>
      <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
      <div className={css.contentContainer}>
        <MobileListingImage
          listingTitle={listingTitle}
          author={listing?.author}
          firstImage={listing?.images?.[0] || null}
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

          <MobileOrderBreakdown breakdown={breakdown} />

          <section className={css.paymentContainer}>
            <div className={css.cashNotice}>
              <p><FormattedMessage id="CheckoutPage.payInCash.instruction" /></p>
              {totalPrice ? (
                <p className={css.totalPrice}>
                  <strong><FormattedMessage id="CheckoutPage.totalPrice" values={{ totalPrice }} /></strong>
                </p>
              ) : null}
            </div>

            <div className={css.confirmRow}>
              <Button
                className={css.primaryButton}
                onClick={handleConfirmCash}
                disabled={submitting || speculateTransactionInProgress}
                type="button"
              >
                {submitting
                  ? <FormattedMessage id="CheckoutPage.confirming" />
                  : <FormattedMessage id="CheckoutPage.payInCash.confirmButton" />}
              </Button>
            </div>

            <div className={css.backLinkRow}>
              <NamedLink name="ListingPage" params={{ id: listing?.id?.uuid, slug: createSlug(listingTitle) }}>
                ← <FormattedMessage id="CheckoutPage.backToListing" />
              </NamedLink>
            </div>
          </section>
        </div>

        <DetailsSideCard
          listing={listing}
          listingTitle={listingTitle}
          author={listing?.author}
          firstImage={listing?.images?.[0] || null}
          layoutListingImageConfig={config.layout.listingImage}
          breakdown={breakdown}
          showListingImage={showListingImage}
          intl={intl}
        />
      </div>
    </Page>
  );
};

export default CheckoutCashPage;
