import React, { useState } from 'react';
import { useHistory } from 'react-router-dom';
import { useIntl, FormattedMessage } from '../../util/reactIntl';
import { useConfiguration } from '../../context/configurationContext';
import { NamedRedirect, Page, H3, PrimaryButton, FieldRadioButton } from '../../components';
import CustomTopbar from '../CheckoutPage/CustomTopbar';
import { handlePageData } from '../CheckoutPage/CheckoutPageSessionHelpers';
import css from '../CheckoutPage/CheckoutPage.module.css';

const STORAGE_KEY = 'CheckoutPage';

const CheckoutPaymentChoicePage = props => {
  const intl = useIntl();
  const history = useHistory();
  const config = useConfiguration();
  const data = handlePageData(
    { orderData: props.orderData, listing: props.listing, transaction: props.transaction },
    STORAGE_KEY,
    history
  );

  if (!data?.listing?.id) {
    const params = props.params || {};
    return <NamedRedirect name="ListingPage" params={params} />;
  }

  const [choice, setChoice] = useState('stripe'); // 'stripe' | 'cash'

  return (
    <Page title={intl.formatMessage({ id: 'CheckoutPaymentChoicePage.title', defaultMessage: 'Mode de paiement' })}>
      <CustomTopbar intl={intl} linkToExternalSite={config?.topbar?.logoLink} />
      <div className={css.contentContainer}>
        <div className={css.orderFormContainer}>
          <H3 as="h1" className={css.heading}>
            <FormattedMessage defaultMessage="Choisissez votre mode de paiement" />
          </H3>

          <div style={{ display: 'grid', gap: '16px', margin: '16px 0 32px' }}>
            <FieldRadioButton
              id="choice-stripe"
              name="paymentChoice"
              label="Carte (Stripe)"
              checked={choice === 'stripe'}
              onChange={() => setChoice('stripe')}
            />
            <FieldRadioButton
              id="choice-cash"
              name="paymentChoice"
              label="Espèces à la remise"
              checked={choice === 'cash'}
              onChange={() => setChoice('cash')}
            />
          </div>

          <PrimaryButton
            type="button"
            onClick={() => history.push(choice === 'cash' ? '/checkout/cash' : '/checkout/stripe')}
          >
            <FormattedMessage defaultMessage="Suivant" />
          </PrimaryButton>
        </div>
      </div>
    </Page>
  );
};

export default CheckoutPaymentChoicePage;
