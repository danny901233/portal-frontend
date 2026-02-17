import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

router.post('/admin/create-fb-connection', async (req, res) => {
  try {
    const garageId = 'd51dfa55-15d0-4d60-ad81-c675579d16f6';
    const pageId = '224576834077659';
    const accessToken = 'EAAWvZApHZBPUwBQjJTmTJ25OYfKab5xQMI1Bt6EntSYPtRqBET2HG5CB0KHONmmrbyOgAClLVi9shkGhKn0BcRZCiAyVasbfhpTZA4IShK3pZAJDJiUJDbfhMy2MsX40rIycYpqa3I1WzKOuT5TjyqTy0DBAESZACuw65pTqpbvwtZB0m7pjDJ5NsuVg6jNkMZBkfW9p';

    console.log('=== Creating Facebook Connection ===');
    console.log('Target Garage ID:', garageId);
    console.log('Page ID:', pageId);

    // First, delete all existing Facebook connections
    const deleted = await prisma.socialMediaConnection.deleteMany({
      where: { platform: 'facebook' },
    });
    console.log(`Deleted ${deleted.count} old Facebook connection(s)`);

    // Create new connection in correct garage
    const connection = await prisma.socialMediaConnection.create({
      data: {
        garageId,
        platform: 'facebook',
        pageId,
        accessToken,
        isActive: true,
      },
    });

    console.log('✅ Facebook connection created successfully!');
    console.log('Connection ID:', connection.id);

    // Verify the garage has GarageHive configured
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      include: { agentConfiguration: true },
    });

    const hasGH = garage?.agentConfiguration?.integrationProvider === 'garagehive' ||
                  (garage?.agentConfiguration?.integrationProviderConfig &&
                   (garage.agentConfiguration.integrationProviderConfig as any).ghCustomerId);

    console.log('GarageHive configured?', hasGH);

    res.json({
      success: true,
      connection: {
        id: connection.id,
        garageId: connection.garageId,
        pageId: connection.pageId,
        platform: connection.platform,
        isActive: connection.isActive,
      },
      garage: {
        name: garage?.name,
        hasGarageHive: hasGH,
      },
      deletedCount: deleted.count,
    });
  } catch (error: any) {
    console.error('❌ Error creating Facebook connection:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

export default router;
