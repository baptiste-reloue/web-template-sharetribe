/* eslint-disable no-console */
import EditListingDepositForm from './EditListingDepositForm';

export const Empty = {
  component: EditListingDepositForm,
  props: {
    onSubmit: values => {
      console.log('Submit EditListingDepositForm with (unformatted) values:', values);
    },
    saveActionMsg: 'Save deposit',
    updated: false,
    updateInProgress: false,
    disabled: false,
    ready: false,
  },
  group: 'page:EditListingPage',
};
