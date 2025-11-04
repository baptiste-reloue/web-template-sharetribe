import React, { useEffect, useState } from 'react';
import { compose } from 'redux';
import { connect } from 'react-redux';
import { useIntl, FormattedMessage } from 'react-intl';
import { useHistory } from 'react-router-dom';

import { useConfiguration } from '../../context/configurationContext';
import { useRouteConfiguration } from '../../context/routeConfigurationContext';

import { propTypes } from '../../util/types';
import { ensureTransaction, userDisplayNameAsString } from '../../util/data';
import { pathByRouteName } from '../../util/routes';

import { Page, H3, H4, OrderBreakdown, NamedLink } from '../../components';

import { handlePageData, storeData } from './CheckoutPageSessionHelpers';
import { initiateOrder, setInitialValues as setInitialValuesDuck } from './CheckoutPage.duck';
import { getFormattedTotalPrice } from './CheckoutPageTransactionHelpers';

import CustomTopbar from './CustomTopbar';
import DetailsSideCard from './DetailsSideCard';
import MobileListingImage from './MobileListingImage';
import MobileOrderBreakdown from './MobileOrderBreakdown';

import css from './CheckoutPage.module.css';

// --- Constantes spécifiques au flux espèces
const STORAGE_KEY = 'CheckoutPage';
const CASH_PROCESS_ALIAS = 'reloue-booking-cash';
const TX_REQUEST = 'transition/request';

// Construit les params d’initiation pour le process cash
const buildOrderParams = (pageData, form) => {
  const { orderData = {}, listing } = pageData || {};
  const { bookingDates, quantity, deliveryMethod } = orderData || {};

  const bookingParams =
    bookingDates && bookingDates.start && bookingDates.end
      ? {
          // Flex attend des clés bookingStart/bookingEnd en ISO
          bookingStart: new Date(bookingDates.start).toISOString(),
          bookingEnd: new Date(bookingDates.end).toISOString(),
        }
      : {};

  return {
    listingId: listing?.id,
    ...bookingParams,
    ...(quantity ? { stockReservationQuantity: quantity } : {}),
    ...(deliveryMethod ? { deliveryMethod } : {}),
    // On stocke le mode de paiement + infos contact côté protectedData
    protectedData: {
      ...(orderData.protectedData || {}),
      paymentMethod: 'cash',
      contactName: form.name || '',
      contactPhone: form.phone || '',
      note: form.message || '',
    },
    // Message initial (facultatif) au propriétaire
    message: form.message || '',
  };
};

const CheckoutCashPageComponent = props => {
  const {
    // Redux
    scrollingDisabled,
    orderData,
    listing,
    transaction,
    onInitiateOrder,
  } = props;

  const intl = useIntl();
  const history = useHistory();
  const config = useConfiguration();
  const routeConfiguration = useRouteConfiguration();

  const [pageData, setPageData] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', message: '' });

  // Récupération/normalisation des données de checkout (Redux + sessionStorage)
  useEffect(() => {
    const data = handlePageData({ orderData, listing, transaction }, STORAGE_KEY, history) || {};
    // Force le mode 'cash' et persiste (utile si on recharge la page)
    const merged = { ...data, orderData: { ...(data.orderData || {}), paymentMethod: 'cash' } };
    storeData(merged.orderData, merged.listing, merged.transaction, STORAGE_KEY);
    setPageData(merged);
  }, []); // mount only

  const listingTitle = pageData?.listing?.attributes?.title || '';
  const authorDisplayName = userDisplayNameAsString(pageData?.listing?.author, '');

  const pageTitle = intl.formatMessage(
    { id: 'CheckoutCashPage.title', defaultMessage: 'Demande de location (espèces) — {listingTitle}' },
    { listingTitle, authorDisplayName }
  );

  const tx = ensureTransaction(pageData?.transaction);
  const timeZone = pageData?.listing?.attributes?.availabilityPlan?.timezone;

  const firstImage = pageData?.listing?.images?.length ? pageData.listing.images[0] : null;

  // Breakdown desktop
  const breakdown =
    tx?.id && tx?.attributes?.lineItems?.length > 0 ? (
      <OrderBreakdown
        className={css.orderBreakdown}
        userRole="customer"
        transaction={tx}
        {...(tx?.booking?.id && timeZone ? { booking: tx.booking, timeZone } : {})}
        currency={config.currency}
        marketplaceName={config.marketplaceName}
      />
    ) : null;

  // Breakdown mobile (si ta version mobile l’affiche)
  const mobileBreakdown =
    tx?.id && tx?.attributes?.lineItems?.length > 0 ? (
      <MobileOrderBreakdown
        className={css.orderBreakdownMobile}
        userRole="customer"
        transaction={tx}
        {...(tx?.booking?.id && timeZone ? { booking: tx.booking, timeZone } : {})}
        currency={config.currency}
        marketplaceName={config.marketplaceName}
      />
    ) : null;

  const totalPrice =
    tx?.attributes?.lineItems?.length > 0 ? getFormattedTotalPrice(tx, intl) : null;

  const goBackToChoice = () => {
    // Retour à la page de choix du mode de paiement (CheckoutPage)
    if (pageData?.listing?.id?.uuid) {
      history.replace(
        pathByRouteName('CheckoutPage', routeConfiguration, {
          id: pageData.listing.id.uuid,
          slug:
            pageData.listing.attributes.title
              ? pageData.listing.attributes.title.toLowerCase().replace(/\s+/g, '-')
              : 'article',
        })
      );
    } else {
      history.goBack();
    }
  };

  const onSubmit = e => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    const params = buildOrderParams(pageData, form);

    // On initie la transaction cash : alias + première transition
    onInitiateOrder(params, CASH_PROCESS_ALIAS, tx?.id || null, TX_REQUEST, false)
      .then(order => {
        // Selon la forme du retour (denormalized / SDK)
        const orderId =
          order?.id?.uuid ||
          order?.payload?.id?.uuid ||
          order?.data?.data?.id?.uuid ||
          order?.data?.data?.id ||
          order?.payload?.data?.data?.id ||
          null;

        if (orderId) {
          const detailsPath = pathByRouteName('OrderDetailsPage', routeConfiguration, { id: orderId });
          history.push(detailsPath);
        } else {
          // fallback : retour à l’annonce si on ne parvient pas à trouver l’ID
          history.push(
            pathByRouteName('ListingPage', routeConfiguration, {
              id: pageData?.listing?.id?.uuid,
            })
          );
        }
      })
      .catch(() => {
        // tu peux afficher un message d’erreur UI ici si tu veux
      })
      .finally(() => setSubmitting(false));
  };

  // Garde-fou : accès direct sans données → bouton retour accueil
  if (!pageData?.listing?.id) {
    return (
      <Page title={pageTitle} scrollingDisabled={scrollingDisabled}>
        <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
        <div className={css.contentContainer}>
          <div className={css.orderFormContainer} style={{ padding: 24 }}>
            <H4 as="h1" className={css.heading}>
              <FormattedMessage id="CheckoutCashPage.missingData" defaultMessage="Données de réservation manquantes" />
            </H4>
            <NamedLink name="LandingPage" className="button">
              <FormattedMessage id="CheckoutCashPage.goHome" defaultMessage="Retour à l’accueil" />
            </NamedLink>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title={pageTitle} scrollingDisabled={scrollingDisabled}>
      <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />

      <div className={css.contentContainer}>
        <div className={css.orderFormContainer}>
          {/* Bouton changement de mode (même position que la page carte) */}
          <div style={{ marginBottom: 12 }}>
            <button type="button" className="buttonSecondary" onClick={goBackToChoice}>
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

          {/* Titres identiques à la page Stripe */}
          <div className={css.headingContainer}>
            <H3 as="h1" className={css.heading}>
              {pageTitle}
            </H3>
            <H4 as="h2" className={css.detailsHeadingMobile}>
              <FormattedMessage id="CheckoutPage.listingTitle" values={{ listingTitle }} />
            </H4>
          </div>

          {/* Bloc lieu (même rendu que la page carte) */}
          <section className={css.locationContainer}>
            <H4 className={css.subTitle}>
              <FormattedMessage id="CheckoutPage.locationTitle" defaultMessage="Lieu de l'objet" />
            </H4>
            <div className={css.locationContent}>
              {pageData?.listing?.attributes?.publicData?.location ||
                pageData?.listing?.attributes?.geolocation?.address ||
                pageData?.listing?.attributes?.deleted ? null : (
                  <FormattedMessage id="CheckoutPage.locationPlaceholder" defaultMessage="—" />
                )}
            </div>
          </section>

          {/* Formulaire SANS STRIPE : nom, téléphone, message */}
          <section className={css.paymentContainer}>
            <form onSubmit={onSubmit} className={css.paymentForm}>
              <div className={css.field}>
                <label className={css.label}>
                  <FormattedMessage id="CheckoutCashPage.name" defaultMessage="Nom & Prénom" />
                </label>
                <input
                  type="text"
                  className={css.input}
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  required
                />
              </div>

              <div className={css.field}>
                <label className={css.label}>
                  <FormattedMessage id="CheckoutCashPage.phone" defaultMessage="Téléphone" />
                </label>
                <input
                  type="tel"
                  className={css.input}
                  value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  required
                />
              </div>

              <div className={css.field}>
                <label className={css.label}>
                  <FormattedMessage
                    id="CheckoutPage.additionalInfo"
                    defaultMessage="Informations additionnelles"
                  />
                </label>
                <textarea
                  className={css.textarea}
                  rows={4}
                  value={form.message}
                  onChange={e => setForm({ ...form, message: e.target.value })}
                  placeholder={intl.formatMessage({
                    id: 'CheckoutCashPage.message.placeholder',
                    defaultMessage:
                      'Y a-t-il quelque chose que le propriétaire devrait savoir ? (horaires, remise en mains propres, etc.)',
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
            </form>
          </section>

          {/* Breakdown mobile */}
          {mobileBreakdown}
        </div>

        {/* Carte de détails (colonne droite) */}
        <DetailsSideCard
          listing={pageData?.listing}
          listingTitle={listingTitle}
          priceVariantName={tx?.attributes?.protectedData?.priceVariantName}
          author={pageData?.listing?.author}
          firstImage={firstImage}
          layoutListingImageConfig={config.layout.listingImage}
          speculateTransactionErrorMessage={null}
          isInquiryProcess={false}
          processName={'reloue-booking-cash'}
          breakdown={breakdown}
          showListingImage={true}
          intl={intl}
          totalPrice={totalPrice}
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
  onInitiateOrder: (params, processAlias, txId, transition, isPriv) =>
    dispatch(initiateOrder(params, processAlias, txId, transition, isPriv)),
  setInitialValues: v => dispatch(setInitialValuesDuck(v)),
});

export default compose(connect(mapStateToProps, mapDispatchToProps))(CheckoutCashPageComponent);
