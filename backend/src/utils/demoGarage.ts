// The one real "ReceptionMate Demo" garage.
//
// Three files had this uuid typed into them (the web-demo token route, the prospect phone
// webhook and the call-log route) and a fourth now needs it: a call logged against this garage
// is, by definition, somebody trying the product rather than a customer's caller, which is what
// makes it a lead worth putting in the CRM.
//
// Overridable by env so a staging box can point at its own demo garage instead of writing calls
// into production's.
export const DEMO_GARAGE_ID = process.env.DEMO_GARAGE_ID || 'c7f53608-b0eb-4bdd-93da-02f2875acd93';

export function isDemoGarage(garageId: string | null | undefined): boolean {
  return Boolean(garageId) && garageId === DEMO_GARAGE_ID;
}
