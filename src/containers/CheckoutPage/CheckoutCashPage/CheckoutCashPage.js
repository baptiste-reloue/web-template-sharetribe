import React, { useEffect, useState } from 'react';
import { compose } from 'redux';
import { connect } from 'react-redux';
import { useIntl, FormattedMessage } from 'react-intl';
import { useHistory } from 'react-router-dom';

import { useConfiguration } from '../../../context/configurationContext';
import { useRouteConfiguration } from '../../../context/routeConfigurationContext';
import { propTypes } from '../../../util/types';
import { ensureTransaction, userDisplayNameAsString } from '../../../util/data';
import { pathByRouteName } from '../../../util/routes';

import { Page, H3, H4, OrderBreakdown } from '../../../components';

import { storeData, handlePageData } from '../CheckoutPageSessionHelpers';
import { initiateCashOrder, setInitialValues as setInitialValuesDuck } from '../CheckoutPage.duck';
import { getFormattedTotalPrice } from '../CheckoutPageTransactionHelpers';

import CustomTopbar from '../CustomTopbar';
import DetailsSideCard from '../DetailsSideCard';
import MobileListingImage from '../MobileListingImage';
import MobileOrderBreakdown from '../MobileOrderBreakdown';

import css from '../CheckoutPage.module.css';

const STORAGE_KEY = 'CheckoutPage';
const PROCESS_KEY = 'reloue-booking-cash';

const buildOrderParams = (pageData, form) => {
  const { orderData = {}, listing } = pageData || {};
  const { bookingDates, quantity, deliveryMethod } = orderData;

  const bookingParams =
    bookingDates && bookingDates.start && bookingDates.end
      ? { bookingStart: bookingDates.start, bookingEnd: bookingDates.end }
      : {};

  return {
    listingId: listing?.id,
    ...bookingParams,
    ...(quantity ? { stockReservationQuantity: quantity } : {}),
    ...(deliveryMethod ? { deliveryMethod } : {}),
    protectedData: {
      ...(orderData.protectedData || {}),
      paymentMethod: 'cash',
      contactName: form.name || '',
      contactPhone: form.phone || '',
      note: form.message || '',
    },
    message: form.message || '',
  };
};

const CheckoutCashPageComponent = props => {
  const {
    scrollingDisabled,
    orderData,
    listing,
    transaction,
    onInitiateCashOrder,
  } = props;

  const config = useConfiguration();
  const routeConfiguration = useRouteConfiguration();
  const intl = useIntl();
  const history = useHistory();

  const [pageData, setPageData] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', message: '' });

  // Lire données session/Redux
  useEffect(() => {
    const data = handlePageData({ orderData, listing, transaction }, STORAGE_KEY, history) || {};
    // Forcer le mode cash dans l'état local
    const merged = { ...data, orderData: { ...(data.orderData || {}), paymentMethod: 'cash' } };
    storeData(merged.orderData, merged.listing, merged.transaction, STORAGE_KEY);
    setPageData(merged);
  }, []);

  const listingTitle = pageData?.listing?.attributes?.title || '';
  const authorDisplayName = userDisplayNameAsString(pageData?.listing?.author, '');
  const title = intl.formatMessage(
    { id: `CheckoutPage.${PROCESS_KEY}.title` },
    { listingTitle, authorDisplayName }
  );

  const existingTx = ensureTransaction(pageData?.transaction);
  const timeZone = pageData?.listing?.attributes?.availabilityPlan?.timezone;

  const breakdown =
    existingTx?.id && existingTx?.attributes?.lineItems?.length > 0 ? (
      <OrderBreakdown
        className={css.orderBreakdown}
        userRole="customer"
        transaction={existingTx}
        {...(existingTx?.booking?.id && timeZone ? { booking: existingTx.booking, timeZone } : {})}
        currency={config.currency}
        marketplaceName={config.marketplaceName}
      />
    ) : null;

  const totalPrice =
    existingTx?.attributes?.lineItems?.length > 0 ? getFormattedTotalPrice(existingTx, intl) : null;

  const firstImage = pageData?.listing?.images?.length ? pageData.listing.images[0] : null;

  const onSubmit = e => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    const params = buildOrderParams(pageData, form);
    onInitiateCashOrder(params, existingTx?.id)
      .then(res => {
        const id = res?.data?.data?.id || res?.payload?.data?.data?.id || null;
        history.push(
          id
            ? pathByRouteName('OrderDetailsPage', routeConfiguration, { id })
            : pathByRouteName('ListingPage', routeConfiguration, {
                id: pageData?.listing?.id?.uuid,
              })
        );
      })
      .catch(() => {})
      .finally(() => setSubmitting(false));
  };

  // Changer de mode → retour à l'écran de choix (CheckoutPage)
  const handleChangeMode = () => {
    history.replace(
      pathByRouteName('CheckoutPage', routeConfiguration, {
        id: pageData?.listing?.id?.uuid,
        slug: pageData?.listing
          ? pageData.listing.attributes.title.toLowerCase().replace(/\s+/g, '-')
          : 'item',
      })
    );
  };

  return (
    <Page title={title} scrollingDisabled={scrollingDisabled}>
      <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />

      <div className={css.contentContainer}>
        <div className={css.orderFormContainer}>
          {/* Changer de mode — AVANT le titre */}
          <div style={{ marginBottom: 12 }}>
            <button type="button" className="buttonSecondary" onClick={handleChangeMode}>
              <FormattedMessage id="CheckoutPage.changePayment" defaultMessage="⟵ Changer de mode de paiement" />
            </button>
          </div>

          <MobileListingImage
            listingTitle={listingTitle}
            author={pageData?.listing?.author}
            firstImage={firstImage}
            layoutListingImageConfig={config.layout.listingImage}
            showListingImage={true}
          />

          <div className={css.headingContainer}>
            <H3 as="h1" className={css.heading}>{title}</H3>
            <H4 as="h2" className={css.detailsHeadingMobile}>
              <FormattedMessage id="CheckoutPage.listingTitle" values={{ listingTitle }} />
            </H4>
          </div>

          {/* Formulaire SANS STRIPE */}
          <section className={css.paymentContainer}>
            <form onSubmit={onSubmit} className={css.paymentForm}>
              <div className="field">
                <label className="label">
                  <FormattedMessage id="CheckoutCashPage.name" defaultMessage="Nom & Prénom" />
                </label>
                <input
                  type="text"
                  className="input"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  required
                />
              </div>

              <div className="field">
                <label className="label">
                  <FormattedMessage id="CheckoutCashPage.phone" defaultMessage="Téléphone" />
                </label>
                <input
                  type="tel"
                  className="input"
                  value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  required
                />
              </div>

              <div className="field">
                <label className="label">
                  <FormattedMessage id="CheckoutCashPage.message" defaultMessage="Message au propriétaire" />
                </label>
                <textarea
                  className="textarea"
                  rows={4}
                  value={form.message}
                  onChange={e => setForm({ ...form, message: e.target.value })}
                  placeholder={intl.formatMessage({
                    id: 'CheckoutCashPage.message.placeholder',
                    defaultMessage: 'Infos utiles (horaires, lieu de remise, etc.)',
                  })}
                />
              </div>

              <div style={{ marginTop: 16 }}>
                <button className="button" type="submit" disabled={submitting}>
                  {submitting ? (
                    <FormattedMessage id="CheckoutCashPage.sending" defaultMessage="Envoi..." />
                  ) : (
                    <FormattedMessage id="CheckoutCashPage.submit" defaultMessage="Envoyer la demande" />
                  )}
                </button>
              </div>
            </form>
          </section>
        </div>

        <DetailsSideCard
          listing={pageData?.listing}
          listingTitle={listingTitle}
          priceVariantName={existingTx?.attributes?.protectedData?.priceVariantName}
          author={pageData?.listing?.author}
          firstImage={firstImage}
          layoutListingImageConfig={config.layout.listingImage}
          speculateTransactionErrorMessage={null}
          isInquiryProcess={false}
          processName={PROCESS_KEY}
          breakdown={
            existingTx?.id && existingTx?.attributes?.lineItems?.length > 0 ? (
              <OrderBreakdown
                className={css.orderBreakdown}
                userRole="customer"
                transaction={existingTx}
                {...(existingTx?.booking?.id && timeZone ? { booking: existingTx.booking, timeZone } : {})}
                currency={config.currency}
                marketplaceName={config.marketplaceName}
              />
            ) : null
          }
          showListingImage={true}
          intl={useIntl()}
        />
      </div>
    </Page>
  );
};

CheckoutCashPageComponent.defaultProps = {
  orderData: null,
  listing: null,
  transaction: null,
};

CheckoutCashPageComponent.propTypes = {
  scrollingDisabled: propTypes.bool.isRequired,
  orderData: propTypes.object,
  listing: propTypes.object,
  transaction: propTypes.tx,
};

const mapStateToProps = state => {
  const { orderData, listing, transaction } = state.CheckoutPage;
  return {
    scrollingDisabled: state.ui.scrollingDisabled,
    orderData,
    listing,
    transaction,
  };
};

const mapDispatchToProps = dispatch => ({
  onInitiateCashOrder: (params, txId) => dispatch(initiateCashOrder(params, txId)),
  setInitialValues: v => dispatch(setInitialValuesDuck(v)),
});

export default compose(connect(mapStateToProps, mapDispatchToProps))(CheckoutCashPageComponent);
