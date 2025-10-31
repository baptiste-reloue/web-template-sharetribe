import { storableError } from '../../util/errors';

/** **************************************************************
 * Action types
 *****************************************************************/
export const SET_INITIAL_VALUES = 'app/CheckoutPage/SET_INITIAL_VALUES';

export const INITIATE_ORDER_REQUEST = 'app/CheckoutPage/INITIATE_ORDER_REQUEST';
export const INITIATE_ORDER_SUCCESS = 'app/CheckoutPage/INITIATE_ORDER_SUCCESS';
export const INITIATE_ORDER_ERROR = 'app/CheckoutPage/INITIATE_ORDER_ERROR';

/** **************************************************************
 * Initial state
 * - IMPORTANT: on garde listing & orderData en Redux pour que
 *   le passage ListingPage -> Checkout conserve bien les dates.
 *****************************************************************/
const initialState = {
  listing: null,
  orderData: {},
  transaction: null,

  initiateOrderError: null,
  confirmPaymentError: null,
};

/** **************************************************************
 * Action creators
 *****************************************************************/
export const setInitialValues = values => ({
  type: SET_INITIAL_VALUES,
  payload: values || {},
});

/** **************************************************************
 * Thunks
 *****************************************************************/

/**
 * Initiate or transition a transaction.
 *
 * @param {Object} orderParams   Params de transition (bookingStart/End, quantity, protectedData, etc.)
 * @param {String} processAlias  e.g. 'default-booking/release-1' ou 'reloue-booking-cash/release-1'
 * @param {UUID?}  transactionId Si présent => transition, sinon => initiate
 * @param {String} transitionName Nom exact de la transition Flex (ex: 'transition/request')
 * @param {Boolean} isPrivilegedTransition Utilise les endpoints *Privileged si true
 */
export const initiateOrder =
  (orderParams, processAlias, transactionId, transitionName, isPrivilegedTransition = false) =>
  (dispatch, getState, sdk) => {
    dispatch({ type: INITIATE_ORDER_REQUEST });

    // Les paramètres envoyés à Flex: dates/quantité/etc. sont déjà dans orderParams
    const bodyParams = transactionId
      ? { id: transactionId, transition: transitionName, params: orderParams }
      : { processAlias, transition: transitionName, params: orderParams };

    // Choix de l'endpoint en fonction du mode (initiate vs transition) et du privilège
    const request = transactionId
      ? isPrivilegedTransition
        ? sdk.transactions.transitionPrivileged(bodyParams)
        : sdk.transactions.transition(bodyParams)
      : isPrivilegedTransition
      ? sdk.transactions.initiatePrivileged(bodyParams)
      : sdk.transactions.initiate(bodyParams);

    return request
      .then(res => {
        dispatch({ type: INITIATE_ORDER_SUCCESS, payload: res.data });
        return res;
      })
      .catch(e => {
        dispatch({ type: INITIATE_ORDER_ERROR, error: storableError(e) });
        throw e;
      });
  };

/** *********************
 * FLOW CASH
 * Force l’alias 'reloue-booking-cash/release-1'
 * et marque protectedData.paymentMethod = 'cash'
 ***********************/

const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';

// ⚠️ METTRE ICI le nom EXACT de la première transition de ton process cash
// (exemples fréquents: 'transition/request' ou 'transition/request-booking')
const CASH_INITIAL_TRANSITION = 'transition/request';

export const initiateCashOrder = (orderParams, transactionId) => (dispatch, getState, sdk) => {
  const paramsWithPaymentFlag = {
    ...orderParams,
    protectedData: {
      ...(orderParams?.protectedData || {}),
      paymentMethod: 'cash',
    },
  };

  return dispatch(
    initiateOrder(
      paramsWithPaymentFlag,
      CASH_PROCESS_ALIAS,
      transactionId,
      CASH_INITIAL_TRANSITION,
      false // privileged ? généralement non pour le cash
    )
  );
};

/** *********************
 * CONFIRMATION DE PAIEMENT (flow carte)
 * Transitionne la transaction après le paiement Stripe
 ***********************/
export const confirmPayment =
  (transactionId, transitionName, transitionParams = {}) =>
  (dispatch, getState, sdk) => {
    // Ici, la plupart du temps on n'a pas besoin du privileged
    return sdk.transactions
      .transition({ id: transactionId, transition: transitionName, params: transitionParams })
      .then(r => r)
      .catch(e => {
        throw storableError(e);
      });
  };

/** *********************
 * ENVOI D’UN MESSAGE (fil de l’order)
 ***********************/
export const sendMessage = params => (dispatch, getState, sdk) =>
  sdk.messages
    .send(params)
    .then(r => r)
    .catch(e => {
      throw storableError(e);
    });

/** **************************************************************
 * Reducer
 *****************************************************************/
export default function reducer(state = initialState, action = {}) {
  const { type, payload, error } = action;

  switch (type) {
    case SET_INITIAL_VALUES: {
      // payload attendu: { listing, orderData, transaction?, confirmPaymentError? }
      const { listing, orderData, transaction = null, confirmPaymentError = null } = payload || {};
      return {
        ...state,
        listing: listing || null,
        orderData: orderData || {},
        transaction,
        confirmPaymentError,
        // reset de l’erreur d’initiation le cas échéant
        initiateOrderError: null,
      };
    }

    case INITIATE_ORDER_REQUEST:
      return {
        ...state,
        initiateOrderError: null,
      };

    case INITIATE_ORDER_SUCCESS:
      return {
        ...state,
        transaction: payload?.data || null,
      };

    case INITIATE_ORDER_ERROR:
      return {
        ...state,
        initiateOrderError: error,
      };

    default:
      return state;
  }
