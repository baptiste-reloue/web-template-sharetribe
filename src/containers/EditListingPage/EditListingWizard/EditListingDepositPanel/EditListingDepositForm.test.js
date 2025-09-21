import React from 'react';
import '@testing-library/jest-dom';

import { fakeIntl } from '../../../../util/testData';
import { renderWithProviders as render, testingLibrary } from '../../../../util/testHelpers';

import EditListingDepositForm from './EditListingDepositForm';

const { screen, userEvent } = testingLibrary;

const noop = () => null;

describe('EditListingDepositForm', () => {
  test('Check that deposit can be given and submit button activates', () => {
    const saveActionMsg = 'Save deposit';
    render(
      <EditListingDepositForm
        intl={fakeIntl}
        dispatch={noop}
        onSubmit={v => v}
        unitType="day"
        saveActionMsg={saveActionMsg}
        updated={false}
        updateInProgress={false}
        disabled={false}
        ready={false}
      />
    );

    // Test that save button is disabled at first
    expect(screen.getByRole('button', { name: saveActionMsg })).toBeDisabled();

    // Fill mandatory attributes
    const Deposit = 'Deposit';
    userEvent.type(screen.getByRole('textbox', { name: Deposit }), 'Pannier rack');

    // Test that save button is enabled
    expect(screen.getByRole('button', { name: saveActionMsg })).toBeEnabled();
  });
});
