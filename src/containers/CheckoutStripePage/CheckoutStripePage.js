import React from 'react';
import CheckoutPage from '../CheckoutPage/CheckoutPage';
// Stripe = process par défaut
const CheckoutStripePage = props => <CheckoutPage {...props} forcedPaymentMethod="stripe" />;
export default CheckoutStripePage;
