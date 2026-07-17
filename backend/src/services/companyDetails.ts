/**
 * ReceptionMate Ltd's own bank and company details — the ones customers pay INTO and that have
 * to appear on anything we invoice.
 *
 * These were hardcoded separately in inoInvoice.ts, invoicePdf.ts, partnershipTemplate.ts and
 * partnershipPdf.ts. One copy, because a wrong sort code on an invoice means money doesn't
 * arrive, and four copies means three chances to miss a change.
 */

export const BANK = {
  name: 'ReceptionMate Ltd',
  sort: '23-01-20',
  account: '49981874',
} as const;

export const COMPANY_NAME = 'ReceptionMate Ltd';
export const COMPANY_ADDRESS = 'Studio 9, 50–54 St. Paul’s Square, Birmingham B3 1QS';
export const COMPANY_VAT_NO = '494543753';
export const COMPANY_NO = '16839506';

/** One-line footer used across invoices and agreements. */
export const COMPANY_FOOTER = `${COMPANY_NAME} · ${COMPANY_ADDRESS} · VAT ${COMPANY_VAT_NO} · Company ${COMPANY_NO}`;

export const SUPPORT_EMAIL = 'hello@receptionmate.co.uk';

export const RM_LOGO_URL =
  'https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png';

/** Standard VAT rate. Per-garage `Garage.vatRate` overrides this where a garage has one. */
export const DEFAULT_VAT_RATE = 0.2;
