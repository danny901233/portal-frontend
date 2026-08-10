/**
 * One-time: import Elite Autocare tyre products (depot 6) into DB.
 * Run: npx tsx backend/scripts/importEliteAutocare.ts
 */
import { prisma } from '../src/db.js';
import { readFileSync } from 'fs';

const GARAGE_ID = '54942185-443e-4326-86d1-bac50d39c2e4';
const DEPOT_ID = 6;
const CSV_PATH = 'C:/dev/RM PORTAL/Elite-Autocare/Elite Autocare Products.csv';

function idx(headers: string[], name: string) {
  return headers.findIndex(h => h.trim() === name);
}

async function main() {
  const content = readFileSync(CSV_PATH, 'utf-8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',');

  const iStock  = idx(headers, 'Product Stock Number');
  const iEAN    = idx(headers, 'Product EAN');
  const iMfg    = idx(headers, 'Product Manufacturer Code');
  const iTitle  = idx(headers, 'Product Title');
  const iRetail = idx(headers, 'Retail');
  const iWidth  = idx(headers, 'Width');
  const iAspect = idx(headers, 'Aspect Ratio');
  const iRim    = idx(headers, 'Rim');
  const iSpeed  = idx(headers, 'Speed Rating');
  const iLoad   = idx(headers, 'Load Index');
  const iReinf  = idx(headers, 'Reinforced');
  const iVeh    = idx(headers, 'Vehicle Type');
  const iProd   = idx(headers, 'Product Type');
  const iRun    = idx(headers, 'Runflat');
  const iRoll   = idx(headers, 'Rolling Resistance');
  const iWet    = idx(headers, 'Wet Grip');
  const iNoise  = idx(headers, 'Noise Performance');
  const iNoiseC = idx(headers, 'Noise Class Type');
  const iEC     = idx(headers, 'EC Vehicle Class');
  const iAdd    = idx(headers, 'Additional Info');
  const iOE     = idx(headers, 'OE Fitment');
  const iAvail  = idx(headers, 'Product Channel Available');
  const iLead   = idx(headers, 'Product Channel Lead Time');
  const iSupp   = idx(headers, 'Product Channel Source Supplier ID');
  const iBrand  = idx(headers, 'Brand Name');

  const feedVersion = new Date().toISOString();
  const rows: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 5) continue;
    const stockNumber = c[iStock]?.trim();
    if (!stockNumber) continue;
    const leadTimeStr = c[iLead]?.trim() ?? '';
    const leadDaysMatch = leadTimeStr.match(/(\d+)/);
    rows.push({
      garageId: GARAGE_ID,
      depotId: DEPOT_ID,
      stockNumber,
      ean: c[iEAN]?.trim() || null,
      manufacturerCode: c[iMfg]?.trim() || null,
      title: c[iTitle]?.trim() ?? '',
      retailPrice: parseFloat(c[iRetail] ?? '0') || 0,
      width: c[iWidth]?.trim() ?? '',
      aspectRatio: c[iAspect]?.trim() ?? '',
      rim: c[iRim]?.trim() ?? '',
      speedRating: c[iSpeed]?.trim() || null,
      loadIndex: c[iLoad]?.trim() || null,
      reinforced: c[iReinf]?.trim() || null,
      vehicleType: c[iVeh]?.trim() || null,
      productType: c[iProd]?.trim() || null,
      runflat: (c[iRun]?.trim().toUpperCase() ?? '') === 'TRUE',
      rollingResistance: c[iRoll]?.trim() || null,
      wetGrip: c[iWet]?.trim() || null,
      noisePerformance: c[iNoise]?.trim() || null,
      noiseClassType: c[iNoiseC]?.trim() || null,
      ecVehicleClass: c[iEC]?.trim() || null,
      additionalInfo: c[iAdd]?.trim() || null,
      oeFitment: c[iOE]?.trim() || null,
      brandName: c[iBrand]?.trim() ?? '',
      channelAvailable: parseInt(c[iAvail]?.trim() || '0') || null,
      leadTime: leadTimeStr || 'In Stock',
      leadTimeDays: leadDaysMatch ? parseInt(leadDaysMatch[1]) : 0,
      sourceSupplierID: parseInt(c[iSupp]?.trim() || '0') || 0,
      feedVersion,
    });
  }

  console.log(`Parsed ${rows.length} products from CSV`);

  await prisma.$transaction([
    prisma.tyreProduct.deleteMany({ where: { garageId: GARAGE_ID, depotId: DEPOT_ID } }),
    // Also clean up wrongly-seeded depot 1 records
    prisma.tyreProduct.deleteMany({ where: { garageId: GARAGE_ID, depotId: 1 } }),
    prisma.tyreProduct.createMany({ data: rows }),
  ]);

  const total = await prisma.tyreProduct.count({ where: { garageId: GARAGE_ID, depotId: DEPOT_ID } });
  const partner = await prisma.tyreProduct.count({ where: { garageId: GARAGE_ID, depotId: DEPOT_ID, sourceSupplierID: { gt: 0 } } });
  console.log(`Seeded: ${total} total, ${partner} partner stock (with lead time)`);
  const sample = await prisma.tyreProduct.findFirst({ where: { garageId: GARAGE_ID, depotId: DEPOT_ID, sourceSupplierID: { gt: 0 } } });
  if (sample) console.log(`Sample partner: ${sample.title} | leadTime: ${sample.leadTime} | days: ${sample.leadTimeDays} | suppId: ${sample.sourceSupplierID}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
