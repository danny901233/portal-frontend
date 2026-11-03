// Generated twin of backend/src/utils/servicesCatalogue.ts — the frontend cannot import
// backend/src, and config.services.test.ts fails if the two key lists ever diverge.
/**
 * What work a garage does — the controlled vocabulary behind the Services tab.
 *
 * A garage's website will never list every job on a car, so "do you do timing chains?" cannot
 * be answered from the knowledge base, and it must NOT be answered from the model's own ideas
 * about garages: that would be a claim about someone else's business. So the garage answers
 * once, here, and the agent reads it.
 *
 * Three states, and the third is the important one:
 *   ticked     -> the agent may say yes, and may book it
 *   un-ticked  -> the agent says no, and does not offer it (one garage complained the agent
 *                 offered an MOT and a service after arranging tyres, neither of which it does)
 *   NOT SET    -> servicesOffered is null. The garage has not answered, so the agent claims
 *                 nothing either way and takes a message, exactly as it did before this tab.
 *
 * `null` and `[]` are therefore different things and neither may be defaulted into the other.
 *
 * Keys are matched to a caller's words by the agent (services_offered.py in
 * receptionmate-agents). Keep this list and that one in step: a key here that the agent does
 * not know simply reads as "not set" for that question, which is safe but useless.
 */
export interface ServiceCatalogueEntry {
  key: string;
  label: string;
  group: string;
}

export const SERVICE_CATALOGUE: ServiceCatalogueEntry[] = [
  { key: 'mot', label: 'MOT', group: 'Servicing & MOT' },
  { key: 'full_service', label: 'Full service', group: 'Servicing & MOT' },
  { key: 'interim_service', label: 'Interim service', group: 'Servicing & MOT' },
  { key: 'oil_change', label: 'Oil and filter change', group: 'Servicing & MOT' },
  { key: 'brakes', label: 'Brakes', group: 'Repairs' },
  { key: 'tyres', label: 'Tyres, tracking and balancing', group: 'Tyres & wheels' },
  { key: 'exhaust', label: 'Exhausts, cats and DPFs', group: 'Repairs' },
  { key: 'suspension', label: 'Suspension', group: 'Repairs' },
  { key: 'steering', label: 'Steering', group: 'Repairs' },
  { key: 'clutch', label: 'Clutches', group: 'Repairs' },
  { key: 'gearbox', label: 'Gearboxes', group: 'Repairs' },
  { key: 'timing_belt', label: 'Timing belts and chains', group: 'Repairs' },
  { key: 'engine_repair', label: 'Engine repairs', group: 'Repairs' },
  { key: 'diagnostics', label: 'Diagnostics and warning lights', group: 'Diagnostics & electrics' },
  { key: 'electrical', label: 'Auto electrics', group: 'Diagnostics & electrics' },
  { key: 'air_con', label: 'Air conditioning', group: 'Diagnostics & electrics' },
  { key: 'cooling', label: 'Cooling systems', group: 'Repairs' },
  { key: 'fuel_system', label: 'Fuel systems', group: 'Repairs' },
  { key: 'welding', label: 'Welding', group: 'Bodywork & glass' },
  { key: 'bodywork', label: 'Bodywork and paint', group: 'Bodywork & glass' },
  { key: 'windscreen', label: 'Windscreens and glass', group: 'Bodywork & glass' },
  { key: 'ev_hybrid', label: 'Electric and hybrid vehicles', group: 'Vehicle types' },
  { key: 'lpg', label: 'LPG', group: 'Vehicle types' },
  { key: 'motorhome', label: 'Motorhomes and campers', group: 'Vehicle types' },
  { key: 'commercial', label: 'Vans and commercials', group: 'Vehicle types' },
  { key: 'courtesy_car', label: 'Courtesy cars', group: 'What you offer' },
  { key: 'collection', label: 'Collection and delivery', group: 'What you offer' },
  { key: 'recovery', label: 'Recovery', group: 'What you offer' },
  { key: 'warranty_servicing', label: 'Warranty servicing', group: 'Servicing & MOT' },
  { key: 'pre_purchase', label: 'Pre-purchase inspections', group: 'What you offer' },
];

export const SERVICE_GROUPS: string[] = [
  'Servicing & MOT',
  'Repairs',
  'Tyres & wheels',
  'Diagnostics & electrics',
  'Bodywork & glass',
  'Vehicle types',
  'What you offer',
];

export const SERVICE_KEYS: string[] = SERVICE_CATALOGUE.map((e) => e.key);
