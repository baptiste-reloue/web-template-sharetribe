import { denormalisedResponseEntities } from '../../util/data';
import { storableError } from '../../util/errors';
import * as log from '../../util/log';

// ================ Action types ================ //

export const SET_INITIAL_VALUES = 'app/CheckoutPage/SET_INITIAL_VALUES';

export const INITIATE_ORDER_REQUEST = 'app/CheckoutPage/INITIATE_ORDER_REQUEST';
export const INITIATE_ORDER_SUCCESS = 'app/CheckoutPage/INITIATE_ORDER_SUCCESS';
export const INITIATE_ORDER_ERROR = 'app/CheckoutPage/INITIATE_ORDER_ERROR';

export const CONFIRM_PAYMENT_REQUEST = 'app/CheckoutPage/CONFIRM_PAYMENT_REQUEST';
export const CONFIRM_PAYMENT_SUCCESS = 'app/CheckoutPage/CONFIRM_PAYMENT_SUCCESS';
export const CONFIRM_PAYMENT_ERROR = 'app/CheckoutPage/CONFIRM_PAYMENT_ERROR';

// tu as peut-être déjà ces 3 types dans ton fichier réel.
// Garde les autres types (speculateTransaction, etc.) si tu les as déjà.


// ================ Initial state ================ //

const initialState = {
  orderData: null,
  listing: null,
  transaction: null,

  // flags / errors
  initiateOrderError: null,
  confirmPaymentError: null,
};

// ================ Reducer ================ //

export default function checkoutPageReducer(state = initialState, action = {}) {
  const { type, payload } = action;

  switch (type) {
    case SET_INITIAL_VALUES: {
      const { orderData, listing, transaction } = payload;
      return {
        ...state,
        orderData,
        listing,
        transaction,
      };
    }

    case INITIATE_ORDER_REQUEST:
      return {
        ...state,
        initiateOrderError: null,
      };
    case INITIATE_ORDER_SUCCESS: {
      const tx = payload.transaction;
      return {
        ...state,
        transaction: tx,
        initiateOrderError: null,
      };
    }
    case INITIATE_ORDER_ERROR:
      return {
        ...state,
        initiateOrderError: payload,
      };

    case CONFIRM_PAYMENT_REQUEST:
      return {
        ...state,
        confirmPaymentError: null,
      };
    case CONFIRM_PAYMENT_SUCCESS: {
      const tx = payload.transaction;
      return {
        ...state,
        transaction: tx,
        confirmPaymentError: null,
      };
    }
    case CONFIRM_PAYMENT_ERROR:
      return {
        ...state,
        confirmPaymentError: payload,
      };

    default:
      return state;
  }
}

// ================ Action creators ================ //

export const setInitialValues = initialValues => ({
  type: SET_INITIAL_VALUES,
  payload: initialValues,
});

const initiateOrderRequest = () => ({ type: INITIATE_ORDER_REQUEST });
const initiateOrderSuccess = transaction => ({
  type: INITIATE_ORDER_SUCCESS,
  payload: { transaction },
});
const initiateOrderError = e => ({
  type: INITIATE_ORDER_ERROR,
  payload: e,
  error: true,
});

const confirmPaymentRequest = () => ({ type: CONFIRM_PAYMENT_REQUEST });
const confirmPaymentSuccess = transaction => ({
  type: CONFIRM_PAYMENT_SUCCESS,
  payload: { transaction },
});
const confirmPaymentError = e => ({
  type: CONFIRM_PAYMENT_ERROR,
  payload: e,
  error: true,
});

// ================ Thunks ================ //

/**
 * initiateOrder
 *
 * Lance soit:
 *  - une nouvelle transaction avec sdk.transactions.initiate()
 *  - soit une transition sur une transaction existante avec sdk.transactions.transition()
 *
 * NOTE:
 *  - processAlias est du style 'default-booking/release-1' ou 'reloue-booking-cash/release-1'
 *  - transitionName est la première transition à appeler dans ce process
 *  - transitionParams contient les dates, quantité, etc.
 */
export const initiateOrder = (
  orderParams,
  processAlias,
  transactionId,
  transitionName,
  isPrivilegedTransition
) => (dispatch, getState, sdk) => {
  dispatch(initiateOrderRequest());

  // On extrait les champs connus
  const {
    deliveryMethod,
    quantity,
    bookingDates,
    ...otherOrderParams
  } = orderParams;

  const quantityMaybe = quantity ? { stockReservationQuantity: quantity } : {};
  const bookingParamsMaybe = bookingDates || {};

  // On prépare les params pour la transition côté Flex API
  const transitionParams = {
    ...quantityMaybe,
    ...bookingParamsMaybe,
    ...otherOrderParams,
  };

  // Soit on démarre une nouvelle transaction (initiate),
  // soit on en continue une existante (transition)
  const bodyParams = transactionId
    ? {
        id: transactionId,
        transition: transitionName,
        params: transitionParams,
      }
    : {
        processAlias,
        transition: transitionName,
        params: transitionParams,
      };

  const initiateFn = transactionId
    ? params => sdk.transactions.transition(params)
    : params => sdk.transactions.initiate(params);

  return initiateFn(bodyParams)
    .then(response => {
      const entities = denormalisedResponseEntities(response);
      const tx = entities[0];

      dispatch(initiateOrderSuccess(tx));
      return response;
    })
    .catch(e => {
      log.error(e, 'initiate-order-failed', {
        transactionId,
        processAlias,
        transitionName,
      });
      dispatch(initiateOrderError(storableError(e)));
      throw e;
    });
};

/**
 * CONFIRM PAYMENT FLOW (Stripe)
 *
 * Après que Stripe ait confirmé la carte (onConfirmCardPayment), on appelle cette
 * transition finale pour marquer la transaction comme payée côté process Stripe.
 */
export const confirmPayment = (
  transactionId,
  transitionName,
  transitionParams
) => (dispatch, getState, sdk) => {
  dispatch(confirmPaymentRequest());

  const bodyParams = {
    id: transactionId,
    transition: transitionName,
    params: transitionParams,
  };

  return sdk.transactions
    .transition(bodyParams)
    .then(response => {
      const entities = denormalisedResponseEntities(response);
      const tx = entities[0];

      dispatch(confirmPaymentSuccess(tx));
      return response;
    })
    .catch(e => {
      log.error(e, 'confirm-payment-failed', {
        transactionId,
        transitionName,
      });
      dispatch(confirmPaymentError(storableError(e)));
      throw e;
    });
};

/**
 * Envoi du premier message (après paiement Stripe ou après demande cash).
 * Ton projet l'a probablement déjà, on le garde par cohérence avec processCheckoutWithPayment.
 */
export const sendMessage = params => (dispatch, getState, sdk) => {
  const { transactionId, content } = params;
  return sdk.messages.send({ transactionId, content });
};

/**
 * INITIATE CASH ORDER
 *
 * Objectif : créer une transaction sur le process cash
 * (alias 'reloue-booking-cash/release-1') SANS passer par Stripe,
 * mais en bloquant le calendrier.
 *
 * On ajoute aussi protectedData.paymentMethod = 'cash'
 * pour que le propriétaire voie que le locataire va payer en espèces.
 */

// ⚠ IMPORTANT : adapte ce nom de transition pour matcher TA première transition
// dans le process "reloue-booking-cash/release-1" dans Flex Console.
// C'est souvent 'transition/request' ou 'transition/request-booking'.
const CASH_INITIAL_TRANSITION = 'transition/request';

const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';

export const initiateCashOrder = (orderParams, transactionId) => (
  dispatch,
  getState,
  sdk
) => {
  // On force le flag paymentMethod dans protectedData
  const orderParamsWithPaymentFlag = {
    ...orderParams,
    protectedData: {
      ...(orderParams.protectedData || {}),
      paymentMethod: 'cash',
    },
  };

  return dispatch(
    initiateOrder(
      orderParamsWithPaymentFlag,
      CASH_PROCESS_ALIAS,
      transactionId,
      CASH_INITIAL_TRANSITION,
      false // isPrivilegedTransition
    )
  );
};
