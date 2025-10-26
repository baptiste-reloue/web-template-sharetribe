// src/containers/CheckoutPage/CheckoutPage.duck.js
import pick from 'lodash/pick';
import { initiatePrivileged, transitionPrivileged } from '../../util/api';
import { denormalisedResponseEntities } from '../../util/data';
import { storableError } from '../../util/errors';
import * as log from '../../util/log';
import { fetchCurrentUserHasOrdersSuccess, fetchCurrentUser } from '../../ducks/user.duck';

// ================ Action types ================ //

export const SET_INITIAL_VALUES = 'app/CheckoutPage/SET_INITIAL_VALUES';

export const INITIATE_ORDER_REQUEST = 'app/CheckoutPage/INITIATE_ORDER_REQUEST';
export const INITIATE_ORDER_SUCCESS = 'app/CheckoutPage/INITIATE_ORDER_SUCCESS';
export const INITIATE_ORDER_ERROR = 'app/CheckoutPage/INITIATE_ORDER_ERROR';

export const CONFIRM_PAYMENT_REQUEST = 'app/CheckoutPage/CONFIRM_PAYMENT_REQUEST';
export const CONFIRM_PAYMENT_SUCCESS = 'app/CheckoutPage/CONFIRM_PAYMENT_SUCCESS';
export const CONFIRM_PAYMENT_ERROR = 'app/CheckoutPage/CONFIRM_PAYMENT_ERROR';

export const SPECULATE_TRANSACTION_REQUEST = 'app/CheckoutPage/SPECULATE_TRANSACTION_REQUEST';
export const SPECULATE_TRANSACTION_SUCCESS = 'app/CheckoutPage/SPECULATE_TRANSACTION_SUCCESS';
export const SPECULATE_TRANSACTION_ERROR = 'app/CheckoutPage/SPECULATE_TRANSACTION_ERROR';

export const STRIPE_CUSTOMER_REQUEST = 'app/CheckoutPage/STRIPE_CUSTOMER_REQUEST';
export const STRIPE_CUSTOMER_SUCCESS = 'app/CheckoutPage/STRIPE_CUSTOMER_SUCCESS';
export const STRIPE_CUSTOMER_ERROR = 'app/CheckoutPage/STRIPE_CUSTOMER_ERROR';

export const INITIATE_INQUIRY_REQUEST = 'app/CheckoutPage/INITIATE_INQUIRY_REQUEST';
export const INITIATE_INQUIRY_SUCCESS = 'app/CheckoutPage/INITIATE_INQUIRY_SUCCESS';
export const INITIATE_INQUIRY_ERROR = 'app/CheckoutPage/INITIATE_INQUIRY_ERROR';

// ... (le reste des actions et reducer inchangés)

/* --------------------------------------------------------------------------
  Ajout : wrapper pour démarrer une transaction BOOKING en mode CASH
  Ce wrapper force le processAlias sur 'reloue-booking-cash/release-1' et injecte
  un flag protectedData.paymentMethod = 'cash' pour que le propriétaire voie le mode.
  ---------------------------------------------------------------------------*/

// IMPORTANT - adapte cette constante si la transition dans ton process a un nom différent
// Vérifie dans la console Flex le nom exact de la première transition qui bloque les dates.
const CASH_PROCESS_ALIAS = 'reloue-booking-cash/release-1';
// Nom de la transition initiale du process CASH (vérifie dans Flex)
const REQUEST_BOOKING_TRANSITION = 'transition/request'; // <- ADAPTE SI NÉCESSAIRE

// Wrapper qui appelle initiateOrder en forçant le processAlias du CASH
export const initiateCashOrder = (orderParams, transactionId) => (dispatch, getState, sdk) => {
  // Ajout du flag paymentMethod dans protectedData pour l'information provider-side
  const orderParamsWithPaymentFlag = {
    ...orderParams,
    protectedData: {
      ...(orderParams.protectedData || {}),
      paymentMethod: 'cash',
    },
  };

  // On délègue à initiateOrder (déjà existant) pour bénéficier de la même logique
  // d'initiation -> blocage des dates (booking process)
  return dispatch(
    initiateOrder(
      orderParamsWithPaymentFlag,
      CASH_PROCESS_ALIAS,
      transactionId,
      REQUEST_BOOKING_TRANSITION,
      false
    )
  );
};

/* --------------------------------------------------------------------------
  Note: Le reste du fichier (initiateOrder, speculateTransaction, reducer, etc.)
  reste inchangé — on réutilise la fonction initiateOrder existante pour le cash.
  ---------------------------------------------------------------------------*/

// ... (laisser le contenu original du duck pour le reste du fichier)
// Assure-toi que initiateOrder est exporté (il l'est déjà dans ton fichier original).

export default function checkoutPageReducer(state = initialState, action = {}) {
  // conserve ton reducer original (aucun changement nécessaire ici).
}
