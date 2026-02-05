import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate, authenticateApiKey } from '../middleware/auth.js';

const router = Router();

// POST /api/sms/log - Log an SMS booking link send (called by agent)
router.post('/sms/log', authenticateApiKey, async (req: Request, res: Response) => {
  try {
    const { garageId, phoneNumber, twilioMessageSid, status = 'sent' } = req.body;

    if (!garageId || !phoneNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const smsLog = await prisma.smsBookingLink.create({
      data: {
        garageId,
        phoneNumber,
        twilioMessageSid: twilioMessageSid || null,
        status,
        costGbp: 0.99,
      },
    });

    res.json({ success: true, smsLog });
  } catch (error) {
    console.error('Failed to log SMS:', error);
    res.status(500).json({ error: 'Failed to log SMS' });
  }
});

// GET /api/garages/:garageId/sms-stats - Get SMS statistics for billing
router.get(
  '/garages/:garageId/sms-stats',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const { startDate, endDate } = req.query;

      // Build date filter
      const dateFilter: any = {};
      if (startDate && typeof startDate === 'string') {
        dateFilter.gte = new Date(startDate);
      }
      if (endDate && typeof endDate === 'string') {
        dateFilter.lte = new Date(endDate);
      }

      const where: any = { garageId };
      if (Object.keys(dateFilter).length > 0) {
        where.createdAt = dateFilter;
      }

      const totalSent = await prisma.smsBookingLink.count({ where });

      const totalCost = await prisma.smsBookingLink.aggregate({
        where,
        _sum: {
          costGbp: true,
        },
      });

      res.json({
        success: true,
        stats: {
          totalSent,
          totalCost: totalCost._sum.costGbp || 0,
          costPerSms: 0.99,
        },
      });
    } catch (error) {
      console.error('Failed to fetch SMS stats:', error);
      res.status(500).json({ error: 'Failed to fetch SMS stats' });
    }
  }
);

// GET /api/garages/:garageId/sms-stats/csv - Download SMS log as CSV for billing
router.get(
  '/garages/:garageId/sms-stats/csv',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const { startDate, endDate } = req.query;

      // Build date filter
      const dateFilter: any = {};
      if (startDate && typeof startDate === 'string') {
        dateFilter.gte = new Date(startDate);
      }
      if (endDate && typeof endDate === 'string') {
        dateFilter.lte = new Date(endDate);
      }

      const where: any = { garageId };
      if (Object.keys(dateFilter).length > 0) {
        where.createdAt = dateFilter;
      }

      const smsLogs = await prisma.smsBookingLink.findMany({
        where,
        include: {
          garage: {
            select: {
              name: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Build CSV
      const csvRows = [
        ['Date', 'Time', 'Garage', 'Phone Number', 'Status', 'Cost (£)', 'Twilio SID'].join(','),
      ];

      for (const log of smsLogs) {
        const date = new Date(log.createdAt);
        const maskedPhone = log.phoneNumber.slice(0, -3) + '***';

        csvRows.push([
          date.toISOString().split('T')[0],
          date.toTimeString().split(' ')[0],
          log.garage.name,
          maskedPhone,
          log.status,
          log.costGbp.toFixed(2),
          log.twilioMessageSid || '',
        ].join(','));
      }

      const csv = csvRows.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="sms-billing-${garageId}-${startDate || 'all'}-to-${endDate || 'all'}.csv"`
      );
      res.send(csv);
    } catch (error) {
      console.error('Failed to generate SMS CSV:', error);
      res.status(500).json({ error: 'Failed to generate CSV' });
    }
  }
);

export default router;
