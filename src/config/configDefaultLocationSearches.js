import { types as sdkTypes } from '../util/sdkLoader';

const { LatLng, LatLngBounds } = sdkTypes;

// An array of locations to show in the LocationAutocompleteInput when
// the input is in focus but the user hasn't typed in any search yet.
//
// Each item in the array should be an object with a unique `id` (String) and a
// `predictionPlace` (util.types.place) properties.
//
// NOTE: these are highly recommended, since they
//       1) help customers to find relevant locations, and
//       2) reduce the cost of using map providers geocoding API
const defaultLocations = [
{
  id: 'default-lyon',
  predictionPlace: {
    address: 'Lyon, France',
    bounds: new LatLngBounds(new LatLng(45.808,4.898), new LatLng(45.707,4.771)),
  },
},
];
export default defaultLocations;
