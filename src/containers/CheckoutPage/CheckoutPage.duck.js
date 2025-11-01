import { storableError } from '../../util/errors';

/***************************************************************
 * Action types
 ***************************************************************/
export const SET_INITIAL_VALUES = 'app/CheckoutPage/SET_INITIAL_VALUES';
export const INITIATE_ORDER_REQUEST = 'app/CheckoutPage/INITIATE_ORDER_REQUEST';
export const INITIATE_ORDER_SUCCESS = 'app/CheckoutPage/INITIATE_ORDER_SUCCESS';
export const INITIATE_ORDER_ERROR = 'app/CheckoutPage/INITIATE_ORDER_ERROR';

/***************************************************************
 * Initial state
 ***************************************************************/
const initialState = {
  listing: null,
  orderData: {},
  transaction: null,
  initiateOrderError: null,
  confirmPaymentError: null,
};

/***************************************************************
 * Action creators
 ***************************************************************/
export const setInitialValues = values => ({
  type: SET_INITIAL_VALUES,
  payload: values || {},
});

/***************************************************************
 * Thunks
 ***************************************************************/
export const initiateOrder =
  (orderParams, processAlias, transactionId, transitionName, isPrivileged = false) =>
  (dispatch, getState, sdk) => {
    dispatch({ type: INITIATE_ORDER_REQUEST });

    const bodyParams = transactionId
      ? { id: transactionId, transition: transitionName, params: orderParams }
      : { processAlias, transition: transitionName, params: orderParams };

    const req = transactionId
      ? isPrivileged
        ? sdk.transactions.transitionPrivileged(bodyParams)
        : sdk.transactions.transition(bodyParams)
      : isPrivileged
      ? sdk.transactions.initiatePrivileged(bodyParams)
      : sdk.transactions.initiate(bodyParams);

    return req
      .then(res => {
        dispatch({ type: INITIATE_ORDER_SUCCESS, payload: res.data });
        return res;
      })
      .catch(e => {
        dispatch({ type: INITIATE_ORDER_ERROR, error: storableError(e) });
        throw e;
      });
  };

/** CASH */
const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';
// ⚠️ Mets ici le nom EXACT de la première transition de ton process cash
const CASH_INITIAL_TRANSITION = 'transition/request';

export const initiateCashOrder = (orderParams, transactionId) => (dispatch, getState, sdk) => {
  const params = {
    ...orderParams,
    protectedData: {
      ...(orderParams?.protectedData || {}),
      paymentMethod: 'cash',
    },
  };
  return dispatch(
    initiateOrder(params, CASH_PROCESS_ALIAS, transactionId, CASH_INITIAL_TRANSITION, false)
  );
};

export const confirmPayment =
  (transactionId, transitionName, params = {}) =>
  (dispatch, getState, sdk) =>
    sdk.transactions
      .transition({ id: transactionId, transition: transitionName, params })
      .then(r => r)
      .catch(e => {
        throw storableError(e);
      });

export const sendMessage = params => (dispatch, getState, sdk) =>
  sdk.messages
    .send(params)
    .then(r => r)
    .catch(e => {
      throw storableError(e);
    });

/***************************************************************
 * Reducer
 ***************************************************************/
export default function reducer(state = initialState, action = {}) {
  const { type, payload, error } = action;

  switch (type) {
    case SET_INITIAL_VALUES: {
      const { listing, orderData, transaction = null, confirmPaymentError = null } = payload || {};
      return {
        ...state,
        listing: listing || null,
        orderData: orderData || {},
        transaction,
        confirmPaymentError,
        initiateOrderError: null,
      };
    }

    case INITIATE_ORDER_REQUEST:
      return { ...state, initiateOrderError: null };

    case INITIATE_ORDER_SUCCESS:
      return { ...state, transaction: payload?.data || null };

    case INITIATE_ORDER_ERROR:
      return { ...state, initiateOrderError: error };

    default:
      return state;
  }
}
