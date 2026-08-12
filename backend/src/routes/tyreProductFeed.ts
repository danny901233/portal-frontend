import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate, authenticateApiKey } from '../middleware/auth.js';
import { invalidateTyreCache } from '../services/chatAgentTyresoft.js';

const router = Router();

// ---------------------------------------------------------------------------
// Parse lead-time string → integer days  ("2 Days" → 2, "In Stock" → 0)
// ---------------------------------------------------------------------------
function parseLeadTimeDays(leadTime: string): number {
  if (!leadTime) return 0;
  const m = leadTime.match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// POST /api/garages/:garageId/tyre-feed/:depotId
// Accepts CSV text body (Content-Type: text/csv or application/json with { csv })
// Auth: X-API-Key header (same key as onboarding)
// ---------------------------------------------------------------------------
router.post(
  '/garages/:garageId/tyre-feed/:depotId',
  authenticateApiKey,
  async (req, res) => {
    try {
      const { garageId } = req.params;
      const depotId = parseInt(req.params.depotId);

      if (!garageId || isNaN(depotId)) {
        return res.status(400).json({ error: 'garageId and numeric depotId are required' });
      }

      // Verify garage exists
      const garage = await prisma.garage.findUnique({ where: { id: garageId } });
      if (!garage) {
        return res.status(404).json({ error: 'Garage not found' });
      }

      // Accept CSV as: raw text body (text/csv) or JSON { csv: "..." }
      let csvContent: string;
      if (typeof req.body === 'string') {
        csvContent = req.body;
      } else if (req.body?.csv && typeof req.body.csv === 'string') {
        csvContent = req.body.csv;
      } else {
        return res.status(400).json({
          error: 'Provide CSV content as text/csv body or JSON { "csv": "..." }',
        });
      }

      // Parse CSV
      const lines = csvContent.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) {
        return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
      }

      const headers = lines[0].split(',');
      const idx = (name: string) => headers.findIndex(h => h.trim() === name);

      // Required columns
      const iStockNum = idx('Product Stock Number');
      const iTitle = idx('Product Title');
      const iRetail = idx('Retail');
      const iWidth = idx('Width');
      const iAspect = idx('Aspect Ratio');
      const iRim = idx('Rim');
      const iBrand = idx('Brand Name');

      const missing = [];
      if (iStockNum === -1) missing.push('Product Stock Number');
      if (iTitle === -1) missing.push('Product Title');
      if (iRetail === -1) missing.push('Retail');
      if (iWidth === -1) missing.push('Width');
      if (iAspect === -1) missing.push('Aspect Ratio');
      if (iRim === -1) missing.push('Rim');
      if (iBrand === -1) missing.push('Brand Name');

      if (missing.length > 0) {
        return res.status(400).json({ error: `Missing required CSV columns: ${missing.join(', ')}` });
      }

      // Optional columns
      const iEAN = idx('Product EAN');
      const iMfgCode = idx('Product Manufacturer Code');
      const iSpeed = idx('Speed Rating');
      const iLoad = idx('Load Index');
      const iReinforced = idx('Reinforced');
      const iVehicleType = idx('Vehicle Type');
      const iProductType = idx('Product Type');
      const iRunflat = idx('Runflat');
      const iRollingRes = idx('Rolling Resistance');
      const iWetGrip = idx('Wet Grip');
      const iNoisePerfm = idx('Noise Performance');
      const iNoiseClass = idx('Noise Class Type');
      const iECClass = idx('EC Vehicle Class');
      const iAddInfo = idx('Additional Info');
      const iOE = idx('OE Fitment');
      const iAvail = idx('Product Channel Available');
      const iLeadTime = idx('Product Channel Lead Time');
      const iSourceSupp = idx('Product Channel Source Supplier ID');

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
          ean: iEAN !== -1 ? (cols[iEAN]?.trim() ?? null) : null,
          manufacturerCode: iMfgCode !== -1 ? (cols[iMfgCode]?.trim() ?? null) : null,
          title: cols[iTitle]?.trim() ?? '',
          retailPrice: parseFloat(cols[iRetail] ?? '0') || 0,
          width: cols[iWidth]?.trim() ?? '',
          aspectRatio: cols[iAspect]?.trim() ?? '',
          rim: cols[iRim]?.trim() ?? '',
          speedRating: iSpeed !== -1 ? (cols[iSpeed]?.trim() ?? null) : null,
          loadIndex: iLoad !== -1 ? (cols[iLoad]?.trim() ?? null) : null,
          reinforced: iReinforced !== -1 ? (cols[iReinforced]?.trim() ?? null) : null,
          vehicleType: iVehicleType !== -1 ? (cols[iVehicleType]?.trim() ?? null) : null,
          productType: iProductType !== -1 ? (cols[iProductType]?.trim() ?? null) : null,
          runflat: iRunflat !== -1 ? (cols[iRunflat]?.trim().toUpperCase() === 'TRUE') : false,
          rollingResistance: iRollingRes !== -1 ? (cols[iRollingRes]?.trim() ?? null) : null,
          wetGrip: iWetGrip !== -1 ? (cols[iWetGrip]?.trim() ?? null) : null,
          noisePerformance: iNoisePerfm !== -1 ? (cols[iNoisePerfm]?.trim() ?? null) : null,
          noiseClassType: iNoiseClass !== -1 ? (cols[iNoiseClass]?.trim() ?? null) : null,
          ecVehicleClass: iECClass !== -1 ? (cols[iECClass]?.trim() ?? null) : null,
          additionalInfo: iAddInfo !== -1 ? (cols[iAddInfo]?.trim() ?? null) : null,
          oeFitment: iOE !== -1 ? (cols[iOE]?.trim() ?? null) : null,
          brandName: cols[iBrand]?.trim() ?? '',
          channelAvailable: iAvail !== -1 ? (parseInt(cols[iAvail]?.trim() || '0') || null) : null,
          leadTime: leadTimeStr || 'In Stock',
          leadTimeDays: parseLeadTimeDays(leadTimeStr),
          sourceSupplierID: iSourceSupp !== -1 ? (parseInt(cols[iSourceSupp]?.trim() || '0') || 0) : 0,
          feedVersion,
        });
      }

      if (rows.length === 0) {
        return res.status(400).json({ error: 'No valid product rows found in CSV' });
      }

      // Full-replace: delete existing rows for this garage+depot, then bulk insert
      await prisma.$transaction([
        prisma.tyreProduct.deleteMany({ where: { garageId, depotId } }),
        prisma.tyreProduct.createMany({ data: rows }),
      ]);

      // Invalidate in-memory cache so the chat agent picks up new data
      invalidateTyreCache(garageId, depotId);

      console.log(`[TYRE_FEED] Imported ${rows.length} products for garage=${garageId} depot=${depotId}`);

      return res.json({
        success: true,
        imported: rows.length,
        depotId,
        garageId,
        feedVersion,
      });
    } catch (error: any) {
      console.error('[TYRE_FEED] Import error:', error);
      return res.status(500).json({ error: 'Failed to import tyre product feed' });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/agent-config/tyre-feed/:garageId/:depotId
// JWT-authenticated version of the tyre feed upload (for portal UI use)
// Accessible by RECEPTIONMATE_STAFF or the garage's own users
// ---------------------------------------------------------------------------
router.post(
  '/agent-config/tyre-feed/:garageId/:depotId',
  authenticate,
  async (req, res) => {
    try {
      const { garageId } = req.params;
      const depotId = parseInt(req.params.depotId);
      const user = req.user!;

      if (!garageId || isNaN(depotId)) {
        return res.status(400).json({ error: 'garageId and numeric depotId are required' });
      }

      // Access check: staff can upload for any garage; others only for their own
      if (
        user.role !== 'RECEPTIONMATE_STAFF' &&
        user.garageId !== garageId &&
        !user.garageIds?.includes(garageId)
      ) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const garage = await prisma.garage.findUnique({ where: { id: garageId } });
      if (!garage) return res.status(404).json({ error: 'Garage not found' });

      let csvContent: string;
      if (typeof req.body === 'string') {
        csvContent = req.body;
      } else if (req.body?.csv && typeof req.body.csv === 'string') {
        csvContent = req.body.csv;
      } else {
        return res.status(400).json({ error: 'Provide CSV content as text/csv body or JSON { "csv": "..." }' });
      }

      const lines = csvContent.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) {
        return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
      }

      const headers = lines[0].split(',');
      const idx = (name: string) => headers.findIndex(h => h.trim() === name);

      const iStockNum = idx('Product Stock Number');
      const iTitle = idx('Product Title');
      const iRetail = idx('Retail');
      const iWidth = idx('Width');
      const iAspect = idx('Aspect Ratio');
      const iRim = idx('Rim');
      const iBrand = idx('Brand Name');

      const missing = [];
      if (iStockNum === -1) missing.push('Product Stock Number');
      if (iTitle === -1) missing.push('Product Title');
      if (iRetail === -1) missing.push('Retail');
      if (iWidth === -1) missing.push('Width');
      if (iAspect === -1) missing.push('Aspect Ratio');
      if (iRim === -1) missing.push('Rim');
      if (iBrand === -1) missing.push('Brand Name');
      if (missing.length > 0) {
        return res.status(400).json({ error: `Missing required CSV columns: ${missing.join(', ')}` });
      }

      const iEAN = idx('Product EAN');
      const iMfgCode = idx('Product Manufacturer Code');
      const iSpeed = idx('Speed Rating');
      const iLoad = idx('Load Index');
      const iReinforced = idx('Reinforced');
      const iVehicleType = idx('Vehicle Type');
      const iProductType = idx('Product Type');
      const iRunflat = idx('Runflat');
      const iRollingRes = idx('Rolling Resistance');
      const iWetGrip = idx('Wet Grip');
      const iNoisePerfm = idx('Noise Performance');
      const iNoiseClass = idx('Noise Class Type');
      const iECClass = idx('EC Vehicle Class');
      const iAddInfo = idx('Additional Info');
      const iOE = idx('OE Fitment');
      const iAvail = idx('Product Channel Available');
      const iLeadTime = idx('Product Channel Lead Time');
      const iSourceSupp = idx('Product Channel Source Supplier ID');

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
          ean: iEAN !== -1 ? (cols[iEAN]?.trim() ?? null) : null,
          manufacturerCode: iMfgCode !== -1 ? (cols[iMfgCode]?.trim() ?? null) : null,
          title: cols[iTitle]?.trim() ?? '',
          retailPrice: parseFloat(cols[iRetail] ?? '0') || 0,
          width: cols[iWidth]?.trim() ?? '',
          aspectRatio: cols[iAspect]?.trim() ?? '',
          rim: cols[iRim]?.trim() ?? '',
          speedRating: iSpeed !== -1 ? (cols[iSpeed]?.trim() ?? null) : null,
          loadIndex: iLoad !== -1 ? (cols[iLoad]?.trim() ?? null) : null,
          reinforced: iReinforced !== -1 ? (cols[iReinforced]?.trim() ?? null) : null,
          vehicleType: iVehicleType !== -1 ? (cols[iVehicleType]?.trim() ?? null) : null,
          productType: iProductType !== -1 ? (cols[iProductType]?.trim() ?? null) : null,
          runflat: iRunflat !== -1 ? (cols[iRunflat]?.trim().toUpperCase() === 'TRUE') : false,
          rollingResistance: iRollingRes !== -1 ? (cols[iRollingRes]?.trim() ?? null) : null,
          wetGrip: iWetGrip !== -1 ? (cols[iWetGrip]?.trim() ?? null) : null,
          noisePerformance: iNoisePerfm !== -1 ? (cols[iNoisePerfm]?.trim() ?? null) : null,
          noiseClassType: iNoiseClass !== -1 ? (cols[iNoiseClass]?.trim() ?? null) : null,
          ecVehicleClass: iECClass !== -1 ? (cols[iECClass]?.trim() ?? null) : null,
          additionalInfo: iAddInfo !== -1 ? (cols[iAddInfo]?.trim() ?? null) : null,
          oeFitment: iOE !== -1 ? (cols[iOE]?.trim() ?? null) : null,
          brandName: cols[iBrand]?.trim() ?? '',
          channelAvailable: iAvail !== -1 ? (parseInt(cols[iAvail]?.trim() || '0') || null) : null,
          leadTime: leadTimeStr || 'In Stock',
          leadTimeDays: parseLeadTimeDays(leadTimeStr),
          sourceSupplierID: iSourceSupp !== -1 ? (parseInt(cols[iSourceSupp]?.trim() || '0') || 0) : 0,
          feedVersion,
        });
      }

      if (rows.length === 0) {
        return res.status(400).json({ error: 'No valid product rows found in CSV' });
      }

      await prisma.$transaction([
        prisma.tyreProduct.deleteMany({ where: { garageId, depotId } }),
        prisma.tyreProduct.createMany({ data: rows }),
      ]);

      invalidateTyreCache(garageId, depotId);
      console.log(`[TYRE_FEED] Imported ${rows.length} products for garage=${garageId} depot=${depotId} (portal upload)`);

      return res.json({ success: true, imported: rows.length, depotId, garageId, feedVersion });
    } catch (error: any) {
      console.error('[TYRE_FEED] Portal import error:', error);
      return res.status(500).json({ error: 'Failed to import tyre product feed' });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/garages/:garageId/tyre-inventory?depotId=X
// Returns tyre products for a garage/depot (for voice agent to consume)
// Auth: X-API-Key
// ---------------------------------------------------------------------------
router.get(
  '/garages/:garageId/tyre-inventory',
  authenticateApiKey,
  async (req, res) => {
    try {
      const { garageId } = req.params;
      const depotId = req.query.depotId ? parseInt(req.query.depotId as string) : undefined;

      const where: any = { garageId };
      if (depotId !== undefined) where.depotId = depotId;

      const products = await prisma.tyreProduct.findMany({ where });

      return res.json({
        success: true,
        count: products.length,
        products: products.map(p => ({
          stockNumber: p.stockNumber,
          ean: p.ean,
          title: p.title,
          price: p.retailPrice,
          width: p.width,
          aspectRatio: p.aspectRatio,
          rim: p.rim,
          speedRating: p.speedRating,
          loadIndex: p.loadIndex,
          brand: p.brandName,
          runflat: p.runflat,
          availability: p.leadTime === 'In Stock' ? 'In Stock' : `${p.leadTimeDays} Days`,
          leadTime: p.leadTime,
          leadTimeDays: p.leadTimeDays,
          sourceSupplierID: p.sourceSupplierID,
        })),
      });
    } catch (error: any) {
      console.error('[TYRE_FEED] Inventory fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch tyre inventory' });
    }
  },
);

export default router;
