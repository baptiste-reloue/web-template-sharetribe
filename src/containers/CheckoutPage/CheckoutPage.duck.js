import { storableError } from '../../util/errors';

// Nom de l'action
export const INITIATE_ORDER_REQUEST = 'app/CheckoutPage/INITIATE_ORDER_REQUEST';
export const INITIATE_ORDER_SUCCESS = 'app/CheckoutPage/INITIATE_ORDER_SUCCESS';
export const INITIATE_ORDER_ERROR = 'app/CheckoutPage/INITIATE_ORDER_ERROR';

// Thunk principal utilisé par Stripe ET Cash
export const initiateOrder = (orderParams, processAlias, transactionId, transitionName, isPrivilegedTransition) => (
  dispatch,
  getState,
  sdk
) => {
  dispatch({ type: INITIATE_ORDER_REQUEST });
  const isTransition = !!transactionId;

  const { quantity, bookingDates, ...otherParams } = orderParams;
  const quantityMaybe = quantity ? { stockReservationQuantity: quantity } : {};
  const bookingParamsMaybe = bookingDates || {};
  const transitionParams = { ...quantityMaybe, ...bookingParamsMaybe, ...otherParams };

  const bodyParams = isTransition
    ? { id: transactionId, transition: transitionName, params: transitionParams }
    : { processAlias, transition: transitionName, params: transitionParams };

  const request = isTransition
    ? sdk.transactions.transition(bodyParams)
    : sdk.transactions.initiate(bodyParams);

  return request
    .then(response => {
      dispatch({ type: INITIATE_ORDER_SUCCESS, payload: response.data });
      return response;
    })
    .catch(e => {
      dispatch({ type: INITIATE_ORDER_ERROR, error: storableError(e) });
      throw e;
    });
};

// -----------------
// MODE CASH
// -----------------
const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';
const CASH_INITIAL_TRANSITION = 'transition/request';

export const initiateCashOrder = (orderParams, transactionId) => (dispatch, getState, sdk) => {
  const paramsWithPaymentFlag = {
    ...orderParams,
    protectedData: { ...(orderParams.protectedData || {}), paymentMethod: 'cash' },
  };
  return dispatch(
    initiateOrder(paramsWithPaymentFlag, CASH_PROCESS_ALIAS, transactionId, CASH_INITIAL_TRANSITION, false)
  );
};

// Exemple d'autres exports utilisés ailleurs :
export const confirmPayment = (txId, transitionName, params) => (dispatch, getState, sdk) =>
  sdk.transactions
    .transition({ id: txId, transition: transitionName, params })
    .then(r => r)
    .catch(e => {
      throw storableError(e);
    });

export const sendMessage = params => (dispatch, getState, sdk) =>
  sdk.messages.send(params).catch(e => {
    throw storableError(e);
  });

export const setInitialValues = values => ({ type: 'app/CheckoutPage/SET_INITIAL_VALUES', payload: values });

// Reducer basique
const initialState = {
  orderData: {},
  initiateOrderError: null,
  transaction: null,
};

export default function reducer(state = initialState, action = {}) {
  const { type, payload, error } = action;
  switch (type) {
    case INITIATE_ORDER_REQUEST:
      return { ...state, initiateOrderError: null };
    case INITIATE_ORDER_SUCCESS:
      return { ...state, transaction: payload.data };
    case INITIATE_ORDER_ERROR:
      return { ...state, initiateOrderError: error };
    default:
      return state;
  }
}
