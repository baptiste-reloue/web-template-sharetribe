import React, { useEffect, useMemo } from 'react';
import { compose } from 'redux';
import { connect } from 'react-redux';
import { useLocation } from 'react-router-dom';
import { useIntl, FormattedMessage } from 'react-intl';

import { isScrollingDisabled } from '../../ducks/ui.duck';
import { ensureOwnListing } from '../../util/data';
import { NamedRedirect, Page } from '../../components';

import {
  initiateOrder as initiateOrderThunk,
  confirmPayment as confirmPaymentThunk,
  stripeCustomer as stripeCustomerThunk,
  speculateTransaction as speculateTransactionThunk,
  CARD_PROCESS_ALIAS,
  TX_REQUEST,
} from './CheckoutPage.duck';

import {
  // on garde seulement ces helpers
  getOrderParams,
  getInitialMessageParams,
  nextTransitionAfterRequest,
} from './CheckoutPageTransactionHelpers';

import { storeData, handlePageData } from './CheckoutPageSessionHelpers';
import CustomTopbar from './CustomTopbar';

import css from './CheckoutPage.module.css';

// --------------------- helpers locaux (pas d'import manquant) ---------------------
const getSearchParams = location => new URLSearchParams(location?.search || '');

// Remplace hasRequiredOrderData : suffit pour booking ou achat qty
const hasRequiredOrderDataLocal = orderData => {
  if (!orderData) return false;
  const { bookingDates, quantity } = orderData;
  const hasBooking =
    bookingDates &&
    bookingDates.start &&
    bookingDates.end;

  const hasQty = typeof quantity === 'number' ? quantity > 0 : !!quantity;
  return Boolean(hasBooking || hasQty);
};
// ---------------------------------------------------------------------------------

const CheckoutPageWithPayment = props => {
  const {
    // fournis par CheckoutPage.js
    sessionStorageKey,
    pageData,
    setPageData,
    title,
    showListingImage,

    // redux
    scrollingDisabled,
    currentUser,
    listing: listingFromRedux,
    orderData: orderDataFromRedux,
    transaction,
    paymentIntent,
    initiateOrderError,
    confirmCardPaymentError,

    // thunks
    onInitiateOrder,
    onConfirmPayment,
    onSpeculateTransaction,
    onStripeCustomer,

    // misc
    config,
  } = props;

  const intl = useIntl();
  const location = useLocation();

  // Récupère les données consolidées (Redux + sessionStorage)
  const data = useMemo(
    () =>
      handlePageData(
        { orderData: orderDataFromRedux, listing: listingFromRedux, transaction },
        sessionStorageKey
      ),
    [orderDataFromRedux, listingFromRedux, transaction, sessionStorageKey]
  );

  const listing = ensureOwnListing(data?.listing);
  const orderData = data?.orderData || {};
  const methodFromUrl = getSearchParams(location).get('method');
  const isCardMode = methodFromUrl === 'card' || orderData?.paymentMethod === 'card';

  // Toujours persister ce qu'on a
  useEffect(() => {
    storeData(orderData, listing, transaction, sessionStorageKey);
  }, [orderData, listing, transaction, sessionStorageKey]);

  // Auth guard (comportement template)
  if (!currentUser) {
    return <NamedRedirect name="LoginPage" state={{ from: location }} />;
  }

  const pageTitle = title || intl.formatMessage({ id: 'CheckoutPage.title' });

  // ⚡️ Auto-init Stripe en mode carte si pas déjà initialisé
  useEffect(() => {
    if (!isCardMode) return;                 // ne touche pas le flux cash
    if (!listing) return;                    // attendre l’annonce
    if (!hasRequiredOrderDataLocal(orderData)) return; // attendre dates/qty
    if (paymentIntent || transaction) return;          // déjà initié

    const orderParams = getOrderParams(orderData, listing.id);
    onInitiateOrder(orderParams, CARD_PROCESS_ALIAS, null, TX_REQUEST, false).catch(() => {});
  }, [isCardMode, listing, orderData, paymentIntent, transaction]);

  // (Optionnel) speculative pour afficher un pricing juste
  useEffect(() => {
    if (!listing) return;
    if (!hasRequiredOrderDataLocal(orderData)) return;
    const orderParams = getOrderParams(orderData, listing.id);
    onSpeculateTransaction(orderParams, CARD_PROCESS_ALIAS, null, TX_REQUEST, false).catch(() => {});
  }, [listing, orderData]);

  // Charger le customer Stripe (PM sauvegardés)
  useEffect(() => {
    onStripeCustomer();
  }, []);

  // Si on n'a pas encore l'annonce (SSR/latence), rend un état neutre
  if (!listing) {
    return (
      <Page title={pageTitle} scrollingDisabled={scrollingDisabled}>
        <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
        <div className={css.contentContainer}>
          <div className={css.orderFormContainer} style={{ textAlign: 'center', marginTop: '4rem' }}>
            <FormattedMessage id="CheckoutPage.loadingListing" defaultMessage="Chargement de l’annonce en cours..." />
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
          <h1 className={css.orderHeading}>
            <FormattedMessage id="CheckoutPageWithPayment.heading" defaultMessage="Finaliser la demande de location" />
          </h1>

          {/* Exemple d’info annonce (adapte selon ton template) */}
          {showListingImage ? (
            <div className={css.listingInfo}>
              <div className={css.listingTitle}>{listing?.attributes?.title}</div>
            </div>
          ) : null}

          {/* Formulaire additionnel / notes au propriétaire → géré ailleurs dans le template */}

          {/* Bouton submit template (si tu le conserves) */}
          <button
            type="button"
            className={`button ${css.submitButton}`}
            onClick={() => {
              const next = nextTransitionAfterRequest(); // helper du template
              if (transaction && next) {
                onConfirmPayment(transaction.id, next, getInitialMessageParams(orderData));
              }
            }}
            disabled={!hasRequiredOrderDataLocal(orderData)}
          >
            <FormattedMessage id="CheckoutPageWithPayment.submit" defaultMessage="Confirmer la demande de location" />
          </button>

          {/* Erreurs éventuelles */}
          {initiateOrderError ? (
            <div className={css.error}>
              {intl.formatMessage({ id: 'CheckoutPageWithPayment.initiateError' })}
            </div>
          ) : null}
          {confirmCardPaymentError ? (
            <div className={css.error}>
              {intl.formatMessage({ id: 'CheckoutPageWithPayment.confirmError' })}
            </div>
          ) : null}
        </div>
      </div>
    </Page>
  );
};

// ----------------------- Redux wiring -----------------------
const mapStateToProps = state => {
  const { listing, orderData, transaction, initiateOrderError } = state.CheckoutPage;
  const { currentUser } = state.user;
  const { paymentIntent, confirmCardPaymentError } = state.stripe;

  return {
    scrollingDisabled: isScrollingDisabled(state),
    currentUser,
    listing,
    orderData,
    transaction,
    paymentIntent,
    initiateOrderError,
    confirmCardPaymentError,
  };
};

const mapDispatchToProps = dispatch => ({
  onInitiateOrder: (params, alias, txId, transition, isPriv) =>
    dispatch(initiateOrderThunk(params, alias, txId, transition, isPriv)),
  onConfirmPayment: (id, name, p) => dispatch(confirmPaymentThunk(id, name, p)),
  onSpeculateTransaction: (params, alias, txId, transition, isPriv) =>
    dispatch(speculateTransactionThunk(params, alias, txId, transition, isPriv)),
  onStripeCustomer: () => dispatch(stripeCustomerThunk()),
});

export default compose(connect(mapStateToProps, mapDispatchToProps))(CheckoutPageWithPayment);
