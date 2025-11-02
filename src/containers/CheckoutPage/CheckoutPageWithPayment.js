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

  // ⬇️ notre config alias/transitions
  CARD_PROCESS_ALIAS,
  TX_REQUEST,
} from './CheckoutPage.duck';

import {
  // helpers d’origine du template
  getOrderParams,
  getInitialMessageParams,
  hasRequiredOrderData,
  nextTransitionAfterRequest,
} from './CheckoutPageTransactionHelpers';

import { storeData, handlePageData } from './CheckoutPageSessionHelpers';
import CustomTopbar from './CustomTopbar';

import css from './CheckoutPage.module.css';

// ----------------------------------------------

const getSearchParams = location => new URLSearchParams(location?.search || '');

const CheckoutPageWithPayment = props => {
  const {
    // from parent (CheckoutPage.js)
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

  // Récupérer pageData propre (depuis Redux + session)
  const data = useMemo(
    () => handlePageData({ orderData: orderDataFromRedux, listing: listingFromRedux, transaction }, sessionStorageKey),
    [orderDataFromRedux, listingFromRedux, transaction]
  );

  const listing = ensureOwnListing(data?.listing);
  const orderData = data?.orderData || {};
  const methodFromUrl = getSearchParams(location).get('method');
  const isCardMode = methodFromUrl === 'card' || orderData?.paymentMethod === 'card';

  // Toujours persister
  useEffect(() => {
    storeData(orderData, listing, transaction, sessionStorageKey);
  }, [orderData, listing, transaction, sessionStorageKey]);

  // 1) Sécurité: si pas connecté → rediriger (comportement template)
  if (!currentUser) {
    return <NamedRedirect name="LoginPage" state={{ from: location }} />;
  }

  // 2) Affichage page & entête
  const pageTitle = title || intl.formatMessage({ id: 'CheckoutPage.title' });

  // 3) ⚡️ Auto-init Stripe en mode carte (si pas déjà initié)
  useEffect(() => {
    if (!isCardMode) return;                  // ne touche pas le flux cash
    if (!listing) return;                     // attendre l’annonce
    if (!hasRequiredOrderData(orderData)) return; // attendre dates/qty
    if (paymentIntent || transaction) return; // déjà initialisé

    // Params d’ordre (dates, qty, etc.)
    const orderParams = getOrderParams(orderData, listing.id);

    // Déclenche l’init sur l’alias CARTE, transition d’entrée standard
    onInitiateOrder(orderParams, CARD_PROCESS_ALIAS, null, TX_REQUEST, false).catch(() => {});
  }, [isCardMode, listing, orderData, paymentIntent, transaction]);

  // 4) Optionnel: faire une speculate pour afficher un pricing à jour (si nécessaire)
  useEffect(() => {
    if (!listing) return;
    if (!hasRequiredOrderData(orderData)) return;
    const orderParams = getOrderParams(orderData, listing.id);
    onSpeculateTransaction(orderParams, CARD_PROCESS_ALIAS, null, TX_REQUEST, false).catch(() => {});
  }, [listing, orderData]);

  // 5) Charger le customer Stripe (moyens de paiement sauvegardés)
  useEffect(() => {
    onStripeCustomer();
  }, []);

  // 6) Rendu principal du checkout par carte
  return (
    <Page title={pageTitle} scrollingDisabled={scrollingDisabled}>
      <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />

      <div className={css.contentContainer}>
        <div className={css.orderFormContainer}>
          <h1 className={css.orderHeading}>
            <FormattedMessage id="CheckoutPageWithPayment.heading" defaultMessage="Finaliser la demande de location" />
          </h1>

          {/* Lieu / visuel / résumé (selon ton template) */}
          {showListingImage ? (
            <div className={css.listingInfo}>
              <div className={css.listingTitle}>{listing?.attributes?.title}</div>
              {/* ici, ton image et/ou localisation si tu le souhaites */}
            </div>
          ) : null}

          {/* Bloc formulaire additionnel (message au propriétaire) */}
          <div className={css.fieldWrapper}>
            <label className={css.fieldLabel}>
              <FormattedMessage id="CheckoutPageWithPayment.additionalInfo" defaultMessage="Informations additionnelles" />
            </label>
            {/* Le template gère souvent ce champ ailleurs; garde comme d’habitude */}
          </div>

          {/* ----- BLOC STRIPE : s’affiche dès que le PaymentIntent est prêt ----- */}
          {/* Ton composant StripeCardForm habituel se base sur `paymentIntent` présent dans Redux */}
          {/* Si ton template affiche le formulaire juste après INITIATE, tu n'as rien à changer ici : */}
          {/* Le submit enverra ensuite la transition suivante (ex: 'transition/confirm-payment') */}

          {/* Bouton submit template (si tu le conserves) */}
          <button
            type="button"
            className={`button ${css.submitButton}`}
            onClick={() => {
              // Dans beaucoup de templates, le clic submit confirme
              // (ici on laisse la logique par défaut; sinon tu peux
              // déclencher un confirm sur la transition suivante):
              const next = nextTransitionAfterRequest(); // helper du template
              if (transaction && next) {
                onConfirmPayment(transaction.id, next, getInitialMessageParams(orderData));
              }
            }}
            disabled={!listing || !hasRequiredOrderData(orderData)}
          >
            <FormattedMessage id="CheckoutPageWithPayment.submit" defaultMessage="Confirmer la demande de location" />
          </button>

          {/* Affichage d’erreurs éventuelles */}
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
