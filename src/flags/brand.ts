// Branded flag tokens. A value of these types has already passed the one regex.
// Platform absence (the word this file does not use) belongs to the single boundary module.

declare const flagKeyBrand: unique symbol;
declare const unitIdBrand: unique symbol;
declare const attributeNameBrand: unique symbol;
declare const attributeValueBrand: unique symbol;
declare const flagSaltBrand: unique symbol;

export type FlagKey = string & { readonly [flagKeyBrand]: 'FlagKey' };
export type UnitId = string & { readonly [unitIdBrand]: 'UnitId' };
export type AttributeName = string & { readonly [attributeNameBrand]: 'AttributeName' };
export type AttributeValue = string & { readonly [attributeValueBrand]: 'AttributeValue' };
export type FlagSalt = string & { readonly [flagSaltBrand]: 'FlagSalt' };

const FLAG_KEY = /^[a-z][a-z0-9._-]{0,63}$/;
const UNIT_ID = /^[A-Za-z0-9._:@+/-]{1,128}$/;
const ATTR_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const ATTR_VALUE = /^[A-Za-z0-9._:@+/-]{1,128}$/;
const SALT = /^[A-Za-z0-9._:-]{1,64}$/;

export type FlagKeyParse = { readonly kind: 'key'; readonly value: FlagKey } | { readonly kind: 'invalid'; readonly reason: string };
export type UnitIdParse = { readonly kind: 'id'; readonly value: UnitId } | { readonly kind: 'invalid'; readonly reason: string };
export type AttributeNameParse = { readonly kind: 'name'; readonly value: AttributeName } | { readonly kind: 'invalid'; readonly reason: string };
export type AttributeValueParse = { readonly kind: 'value'; readonly value: AttributeValue } | { readonly kind: 'invalid'; readonly reason: string };
export type FlagSaltParse = { readonly kind: 'salt'; readonly value: FlagSalt } | { readonly kind: 'invalid'; readonly reason: string };

export function parseFlagKey(raw: string): FlagKeyParse {
  if (!FLAG_KEY.test(raw)) return { kind: 'invalid', reason: 'flag key must match ^[a-z][a-z0-9._-]{0,63}$' };
  return { kind: 'key', value: raw as FlagKey };
}

export function parseUnitId(raw: string): UnitIdParse {
  if (!UNIT_ID.test(raw)) return { kind: 'invalid', reason: 'unit id must be a short token' };
  return { kind: 'id', value: raw as UnitId };
}

export function parseAttributeName(raw: string): AttributeNameParse {
  if (!ATTR_NAME.test(raw)) return { kind: 'invalid', reason: 'attribute names are short tokens' };
  return { kind: 'name', value: raw as AttributeName };
}

export function parseAttributeValue(raw: string): AttributeValueParse {
  if (!ATTR_VALUE.test(raw)) return { kind: 'invalid', reason: 'attribute values are short tokens' };
  return { kind: 'value', value: raw as AttributeValue };
}

export function parseFlagSalt(raw: string): FlagSaltParse {
  if (!SALT.test(raw)) return { kind: 'invalid', reason: 'flag salt is a short token' };
  return { kind: 'salt', value: raw as FlagSalt };
}
