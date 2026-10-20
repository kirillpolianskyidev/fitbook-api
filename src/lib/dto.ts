import type {Location, Money} from './schemas.js';

type LocationLike = {
  name: string;
  address: string;
  city: string;
  state: string;
  lat: number;
  lng: number;
  placeId?: string | null;
  comment?: string | null;
};

export function toLocationDto(location: LocationLike | null | undefined): Location | null {
  if (!location) {
    return null;
  }
  return {
    name: location.name,
    address: location.address,
    city: location.city,
    state: location.state as Location['state'],
    country: 'US',
    lat: location.lat,
    lng: location.lng,
    ...(location.placeId && {placeId: location.placeId}),
    ...(location.comment && {comment: location.comment}),
  };
}

export const toMoneyDto = (money: {amountCents: number; currency?: string | null}): Money => ({
  amountCents: money.amountCents,
  currency: 'USD',
});

export const idOf = (value: {toString(): string}) => value.toString();
