import React from 'react';
import CheckoutPage from '../CheckoutPage/CheckoutPage';
// CASH = même page, mais on force le process cash et on masque Stripe
const CheckoutCashPage = props => <CheckoutPage {...props} forcedPaymentMethod="cash" />;
export default CheckoutCashPage;
