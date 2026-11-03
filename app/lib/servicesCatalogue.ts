// Generated twin of backend/src/utils/servicesCatalogue.ts — the frontend cannot import
// backend/src, and config.services.test.ts fails if the two key lists ever diverge. Both are
// generated from one table, together with the agent's own matcher.
/**
 * What work a garage does — the controlled vocabulary behind the Services tab.
 *
 * A garage's website will never list every job on a car, so "do you do timing chains?" cannot
 * be answered from the knowledge base, and it must NOT be answered from the model's own ideas
 * about garages: that would be a claim about someone else's business. So the garage answers
 * once, here, and the agent reads it.
 *
 * Three states, and the third is the important one:
 *   offered    -> the agent may say yes, and may book it
 *   removed    -> the agent says no, and does not offer it (one garage complained the agent
 *                 offered an MOT and a service after arranging tyres, neither of which it does)
 *   NOT SET    -> servicesOffered is null. The garage has not answered, so the agent claims
 *                 nothing either way and takes a message, exactly as it did before this tab.
 *
 * `null` and `[]` are therefore different things and neither may be defaulted into the other.
 *
 * Keys are generic JOB names, not tiers: "servicing", rather than "full service" and "interim
 * service" as separate answers. No garage does one tier and not the other, and which tier a
 * booking is belongs to the booking.
 *
 * `defaultOn` is what a garage starts with before it has saved anything. The everyday work is
 * on, because removing the handful you do not do beats ticking fifty you do. The last two
 * groups start OFF: most garages do not take motorcycles, LPG or motorhomes and do not run
 * recovery or courtesy cars, and a garage that saves this tab without reading it must not end
 * up claiming work it cannot do — which is the whole point of the feature.
 *
 * Keys are matched to a caller's words by the agent (services_offered.py in
 * receptionmate-agents), generated from the same table as this file.
 */
export interface ServiceCatalogueEntry {
  key: string;
  label: string;
  group: string;
  /** Pre-selected for a garage that has not saved the tab yet. */
  defaultOn: boolean;
}

export const SERVICE_CATALOGUE: ServiceCatalogueEntry[] = [
  { key: 'mot', label: 'MOT', group: 'Servicing & MOT', defaultOn: true },
  { key: 'servicing', label: 'Servicing', group: 'Servicing & MOT', defaultOn: true },
  { key: 'oil_change', label: 'Oil and filter change', group: 'Servicing & MOT', defaultOn: true },
  { key: 'mot_repairs', label: 'MOT failure repairs', group: 'Servicing & MOT', defaultOn: true },
  { key: 'warranty_servicing', label: 'Warranty servicing', group: 'Servicing & MOT', defaultOn: true },
  { key: 'brakes', label: 'Brakes', group: 'Brakes, tyres & wheels', defaultOn: true },
  { key: 'brake_fluid', label: 'Brake fluid change', group: 'Brakes, tyres & wheels', defaultOn: true },
  { key: 'tyres', label: 'Tyres', group: 'Brakes, tyres & wheels', defaultOn: true },
  { key: 'puncture', label: 'Puncture repair', group: 'Brakes, tyres & wheels', defaultOn: true },
  { key: 'alignment', label: 'Wheel alignment and tracking', group: 'Brakes, tyres & wheels', defaultOn: true },
  { key: 'balancing', label: 'Wheel balancing', group: 'Brakes, tyres & wheels', defaultOn: true },
  { key: 'tpms', label: 'Tyre pressure sensors', group: 'Brakes, tyres & wheels', defaultOn: true },
  { key: 'locking_nut', label: 'Locking wheel nut removal', group: 'Brakes, tyres & wheels', defaultOn: true },
  { key: 'wheel_bearings', label: 'Wheel bearings', group: 'Brakes, tyres & wheels', defaultOn: true },
  { key: 'diagnostics', label: 'Diagnostics and warning lights', group: 'Engine & drivetrain', defaultOn: true },
  { key: 'engine_repair', label: 'Engine repairs', group: 'Engine & drivetrain', defaultOn: true },
  { key: 'head_gasket', label: 'Head gaskets', group: 'Engine & drivetrain', defaultOn: true },
  { key: 'timing_belt', label: 'Timing belts and chains', group: 'Engine & drivetrain', defaultOn: true },
  { key: 'clutch', label: 'Clutches', group: 'Engine & drivetrain', defaultOn: true },
  { key: 'gearbox', label: 'Gearboxes and transmissions', group: 'Engine & drivetrain', defaultOn: true },
  { key: 'driveshafts', label: 'Driveshafts and CV joints', group: 'Engine & drivetrain', defaultOn: true },
  { key: 'turbo', label: 'Turbochargers', group: 'Engine & drivetrain', defaultOn: true },
  { key: 'fuel_system', label: 'Fuel systems', group: 'Fuel, exhaust & emissions', defaultOn: true },
  { key: 'wrong_fuel', label: 'Wrong fuel drain', group: 'Fuel, exhaust & emissions', defaultOn: true },
  { key: 'exhaust', label: 'Exhausts', group: 'Fuel, exhaust & emissions', defaultOn: true },
  { key: 'cat', label: 'Catalytic converters', group: 'Fuel, exhaust & emissions', defaultOn: true },
  { key: 'dpf', label: 'DPF cleaning and repair', group: 'Fuel, exhaust & emissions', defaultOn: true },
  { key: 'egr', label: 'EGR valves', group: 'Fuel, exhaust & emissions', defaultOn: true },
  { key: 'adblue', label: 'AdBlue', group: 'Fuel, exhaust & emissions', defaultOn: true },
  { key: 'emissions', label: 'Emissions and smoke', group: 'Fuel, exhaust & emissions', defaultOn: true },
  { key: 'cooling', label: 'Cooling systems and radiators', group: 'Cooling & air conditioning', defaultOn: true },
  { key: 'air_con', label: 'Air conditioning', group: 'Cooling & air conditioning', defaultOn: true },
  { key: 'suspension', label: 'Suspension', group: 'Steering & suspension', defaultOn: true },
  { key: 'steering', label: 'Steering', group: 'Steering & suspension', defaultOn: true },
  { key: 'power_steering', label: 'Power steering', group: 'Steering & suspension', defaultOn: true },
  { key: 'electrical', label: 'Auto electrics', group: 'Electrical', defaultOn: true },
  { key: 'battery', label: 'Batteries', group: 'Electrical', defaultOn: true },
  { key: 'charging', label: 'Alternators and starter motors', group: 'Electrical', defaultOn: true },
  { key: 'lights', label: 'Lights and bulbs', group: 'Electrical', defaultOn: true },
  { key: 'keys', label: 'Keys and immobilisers', group: 'Electrical', defaultOn: true },
  { key: 'software', label: 'Software and ECU updates', group: 'Electrical', defaultOn: true },
  { key: 'bodywork', label: 'Bodywork and paint', group: 'Bodywork & glass', defaultOn: true },
  { key: 'welding', label: 'Welding', group: 'Bodywork & glass', defaultOn: true },
  { key: 'windscreen', label: 'Windscreens and glass', group: 'Bodywork & glass', defaultOn: true },
  { key: 'wipers', label: 'Wipers and washers', group: 'Bodywork & glass', defaultOn: true },
  { key: 'rust', label: 'Rust treatment and underseal', group: 'Bodywork & glass', defaultOn: true },
  { key: 'valeting', label: 'Valeting', group: 'Bodywork & glass', defaultOn: true },
  { key: 'ev_hybrid', label: 'Electric and hybrid vehicles', group: 'Vehicle types', defaultOn: false },
  { key: 'lpg', label: 'LPG', group: 'Vehicle types', defaultOn: false },
  { key: 'motorhome', label: 'Motorhomes and campers', group: 'Vehicle types', defaultOn: false },
  { key: 'commercial', label: 'Vans and commercials', group: 'Vehicle types', defaultOn: false },
  { key: 'classic', label: 'Classic cars', group: 'Vehicle types', defaultOn: false },
  { key: 'motorcycle', label: 'Motorcycles', group: 'Vehicle types', defaultOn: false },
  { key: 'fleet', label: 'Fleet servicing', group: 'Vehicle types', defaultOn: false },
  { key: 'courtesy_car', label: 'Courtesy cars', group: 'What you offer', defaultOn: false },
  { key: 'collection', label: 'Collection and delivery', group: 'What you offer', defaultOn: false },
  { key: 'recovery', label: 'Recovery', group: 'What you offer', defaultOn: false },
  { key: 'pre_purchase', label: 'Pre-purchase inspections', group: 'What you offer', defaultOn: false },
  { key: 'while_you_wait', label: 'While-you-wait appointments', group: 'What you offer', defaultOn: false },
];

export const SERVICE_GROUPS: string[] = [
  'Servicing & MOT',
  'Brakes, tyres & wheels',
  'Engine & drivetrain',
  'Fuel, exhaust & emissions',
  'Cooling & air conditioning',
  'Steering & suspension',
  'Electrical',
  'Bodywork & glass',
  'Vehicle types',
  'What you offer',
];

export const SERVICE_KEYS: string[] = SERVICE_CATALOGUE.map((e) => e.key);

/** What a garage starts with before it has ever saved the tab. */
export const SERVICE_DEFAULTS: string[] =
  SERVICE_CATALOGUE.filter((e) => e.defaultOn).map((e) => e.key);
