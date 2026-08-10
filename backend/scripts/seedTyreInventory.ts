/**
 * Seed existing tyre CSV files into the TyreProduct database table.
 *
 * Usage:
 *   npx tsx backend/scripts/seedTyreInventory.ts <garageId> [--depot1 path] [--depot3 path]
 *
 * If no paths are given, defaults to backend/data/tyresoft-products-depot-{1,3}.csv
 */
import { prisma } from '../src/db.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseLeadTimeDays(leadTime: string): number {
  if (!leadTime) return 0;
  const m = leadTime.match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

function parseCSVToRows(filePath: string, garageId: string, depotId: number) {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    console.warn(`CSV not found: ${filePath} — skipping`);
    return [];
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',');
  const idx = (name: string) => headers.findIndex(h => h.trim() === name);

  const iStockNum   = idx('Product Stock Number');
  const iEAN        = idx('Product EAN');
  const iMfgCode    = idx('Product Manufacturer Code');
  const iTitle      = idx('Product Title');
  const iRetail     = idx('Retail');
  const iWidth      = idx('Width');
  const iAspect     = idx('Aspect Ratio');
  const iRim        = idx('Rim');
  const iSpeed      = idx('Speed Rating');
  const iLoad       = idx('Load Index');
  const iReinforced = idx('Reinforced');
  const iVehType    = idx('Vehicle Type');
  const iProdType   = idx('Product Type');
  const iRunflat    = idx('Runflat');
  const iRollingRes = idx('Rolling Resistance');
  const iWetGrip    = idx('Wet Grip');
  const iNoisePerfm = idx('Noise Performance');
  const iNoiseClass = idx('Noise Class Type');
  const iECClass    = idx('EC Vehicle Class');
  const iAddInfo    = idx('Additional Info');
  const iOE         = idx('OE Fitment');
  const iAvail      = idx('Product Channel Available');
  const iLeadTime   = idx('Product Channel Lead Time');
  const iSourceSupp = idx('Product Channel Source Supplier ID');
  const iBrand      = idx('Brand Name');

  const feedVersion = new Date().toISOString();
  const rows: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    const stockNumber = cols[iStockNum]?.trim() ?? '';
    if (!stockNumber) continue;

    const leadTimeStr = iLeadTime !== -1 ? (cols[iLeadTime]?.trim() ?? '') : '';

    rows.push({
      garageId,
      depotId,
      stockNumber,
      ean: iEAN !== -1 ? (cols[iEAN]?.trim() || null) : null,
      manufacturerCode: iMfgCode !== -1 ? (cols[iMfgCode]?.trim() || null) : null,
      title: cols[iTitle]?.trim() ?? '',
      retailPrice: parseFloat(cols[iRetail] ?? '0') || 0,
      width: cols[iWidth]?.trim() ?? '',
      aspectRatio: cols[iAspect]?.trim() ?? '',
      rim: cols[iRim]?.trim() ?? '',
      speedRating: iSpeed !== -1 ? (cols[iSpeed]?.trim() || null) : null,
      loadIndex: iLoad !== -1 ? (cols[iLoad]?.trim() || null) : null,
      reinforced: iReinforced !== -1 ? (cols[iReinforced]?.trim() || null) : null,
      vehicleType: iVehType !== -1 ? (cols[iVehType]?.trim() || null) : null,
      productType: iProdType !== -1 ? (cols[iProdType]?.trim() || null) : null,
      runflat: iRunflat !== -1 ? (cols[iRunflat]?.trim().toUpperCase() === 'TRUE') : false,
      rollingResistance: iRollingRes !== -1 ? (cols[iRollingRes]?.trim() || null) : null,
      wetGrip: iWetGrip !== -1 ? (cols[iWetGrip]?.trim() || null) : null,
      noisePerformance: iNoisePerfm !== -1 ? (cols[iNoisePerfm]?.trim() || null) : null,
      noiseClassType: iNoiseClass !== -1 ? (cols[iNoiseClass]?.trim() || null) : null,
      ecVehicleClass: iECClass !== -1 ? (cols[iECClass]?.trim() || null) : null,
      additionalInfo: iAddInfo !== -1 ? (cols[iAddInfo]?.trim() || null) : null,
      oeFitment: iOE !== -1 ? (cols[iOE]?.trim() || null) : null,
      brandName: cols[iBrand]?.trim() ?? '',
      channelAvailable: iAvail !== -1 ? (parseInt(cols[iAvail]?.trim() || '0') || null) : null,
      leadTime: leadTimeStr || 'In Stock',
      leadTimeDays: parseLeadTimeDays(leadTimeStr),
      sourceSupplierID: iSourceSupp !== -1 ? (parseInt(cols[iSourceSupp]?.trim() || '0') || 0) : 0,
      feedVersion,
    });
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const garageId = args.find(a => !a.startsWith('--'));

  if (!garageId) {
    console.error('Usage: npx tsx backend/scripts/seedTyreInventory.ts <garageId> [--depot1 path] [--depot3 path]');
    process.exit(1);
  }

  // Verify garage exists
  const garage = await prisma.garage.findUnique({ where: { id: garageId } });
  if (!garage) {
    console.error(`Garage not found: ${garageId}`);
    process.exit(1);
  }

  const dataDir = join(__dirname, '../data');
  const depot1Path = args.find(a => a.startsWith('--depot1='))?.split('=')[1] ?? join(dataDir, 'tyresoft-products-depot-1.csv');
  const depot3Path = args.find(a => a.startsWith('--depot3='))?.split('=')[1] ?? join(dataDir, 'tyresoft-products-depot-3.csv');

  const rows1 = parseCSVToRows(depot1Path, garageId, 1);
  const rows3 = parseCSVToRows(depot3Path, garageId, 3);

  console.log(`Parsed: depot1=${rows1.length} products, depot3=${rows3.length} products`);

  if (rows1.length > 0) {
    await prisma.$transaction([
      prisma.tyreProduct.deleteMany({ where: { garageId, depotId: 1 } }),
      prisma.tyreProduct.createMany({ data: rows1 }),
    ]);
    console.log(`Seeded ${rows1.length} products for depot 1`);
  }

  if (rows3.length > 0) {
    await prisma.$transaction([
      prisma.tyreProduct.deleteMany({ where: { garageId, depotId: 3 } }),
      prisma.tyreProduct.createMany({ data: rows3 }),
    ]);
    console.log(`Seeded ${rows3.length} products for depot 3`);
  }

  console.log(`Done. Garage: ${garage.name} (${garageId})`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
