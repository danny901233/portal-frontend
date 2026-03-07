import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/garages/:garageId/templates — List all templates for a garage
// ---------------------------------------------------------------------------
router.get(
  '/garages/:garageId/templates',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;

      const templates = await prisma.messageTemplate.findMany({
        where: { garageId },
        orderBy: { updatedAt: 'desc' },
      });

      res.json({ success: true, templates });
    } catch (error) {
      console.error('[TEMPLATES] List error:', error);
      res.status(500).json({ error: 'Failed to fetch templates' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/garages/:garageId/templates — Create a new template (draft)
// ---------------------------------------------------------------------------
router.post(
  '/garages/:garageId/templates',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const {
        name,
        category,
        language,
        headerType,
        headerContent,
        bodyText,
        footerText,
        buttonType,
        buttonText,
        buttonValue,
      } = req.body;

      if (!name || !category || !bodyText) {
        return res.status(400).json({ error: 'name, category, and bodyText are required' });
      }

      // Validate template name: lowercase, underscores, no spaces
      const cleanName = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      if (!cleanName) {
        return res.status(400).json({ error: 'Template name must contain letters or numbers' });
      }

      const template = await prisma.messageTemplate.create({
        data: {
          garageId,
          name: cleanName,
          category,
          language: language || 'en_GB',
          headerType: headerType || null,
          headerContent: headerContent || null,
          bodyText,
          footerText: footerText || null,
          buttonType: buttonType || null,
          buttonText: buttonText || null,
          buttonValue: buttonValue || null,
          status: 'draft',
        },
      });

      console.log(`[TEMPLATES] Created: ${template.id} (${cleanName}) for garage ${garageId}`);
      res.json({ success: true, template });
    } catch (error: any) {
      if (error.code === 'P2002') {
        return res.status(409).json({ error: 'A template with this name already exists for this garage' });
      }
      console.error('[TEMPLATES] Create error:', error);
      res.status(500).json({ error: 'Failed to create template' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/garages/:garageId/templates/:templateId/submit — Submit to Meta
// ---------------------------------------------------------------------------
router.post(
  '/garages/:garageId/templates/:templateId/submit',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId, templateId } = req.params;

      const template = await prisma.messageTemplate.findFirst({
        where: { id: templateId, garageId },
      });

      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }

      // Get the WhatsApp connection for this garage
      const connection = await prisma.socialMediaConnection.findFirst({
        where: { garageId, platform: 'whatsapp', isActive: true },
      });

      if (!connection) {
        return res.status(400).json({ error: 'No WhatsApp connection found. Connect WhatsApp first in Integrations.' });
      }

      // Get the WhatsApp Business Account ID
      const wabaId = await getWhatsAppBusinessAccountId(connection.accessToken);
      if (!wabaId) {
        return res.status(400).json({ error: 'Could not find WhatsApp Business Account. Please reconnect WhatsApp.' });
      }

      // Build the Meta template payload
      const components: any[] = [];

      if (template.headerType === 'text' && template.headerContent) {
        components.push({
          type: 'HEADER',
          format: 'TEXT',
          text: template.headerContent,
        });
      }

      components.push({
        type: 'BODY',
        text: template.bodyText,
      });

      if (template.footerText) {
        components.push({
          type: 'FOOTER',
          text: template.footerText,
        });
      }

      if (template.buttonType === 'url' && template.buttonText && template.buttonValue) {
        components.push({
          type: 'BUTTONS',
          buttons: [{
            type: 'URL',
            text: template.buttonText,
            url: template.buttonValue,
          }],
        });
      } else if (template.buttonType === 'call' && template.buttonText && template.buttonValue) {
        components.push({
          type: 'BUTTONS',
          buttons: [{
            type: 'PHONE_NUMBER',
            text: template.buttonText,
            phone_number: template.buttonValue,
          }],
        });
      }

      // Submit to Meta Graph API
      const metaPayload = {
        name: template.name,
        category: template.category,
        language: template.language,
        components,
      };

      console.log(`[TEMPLATES] Submitting to Meta: ${template.name}`, JSON.stringify(metaPayload, null, 2));

      const metaRes = await fetch(
        `https://graph.facebook.com/v18.0/${wabaId}/message_templates`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${connection.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(metaPayload),
        }
      );

      const metaData = await metaRes.json();

      if (!metaRes.ok) {
        console.error('[TEMPLATES] Meta API error:', metaData);
        const errorMsg = metaData.error?.message || 'Meta rejected the template';
        await prisma.messageTemplate.update({
          where: { id: templateId },
          data: { status: 'rejected', rejectionReason: errorMsg },
        });
        return res.status(400).json({ error: errorMsg });
      }

      // Update template with Meta ID and pending status
      const updated = await prisma.messageTemplate.update({
        where: { id: templateId },
        data: {
          metaTemplateId: metaData.id,
          status: 'pending',
          rejectionReason: null,
        },
      });

      console.log(`[TEMPLATES] Submitted OK: metaId=${metaData.id}, status=pending`);
      res.json({ success: true, template: updated });
    } catch (error) {
      console.error('[TEMPLATES] Submit error:', error);
      res.status(500).json({ error: 'Failed to submit template to Meta' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/garages/:garageId/templates/:templateId/sync — Sync status from Meta
// ---------------------------------------------------------------------------
router.post(
  '/garages/:garageId/templates/:templateId/sync',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId, templateId } = req.params;

      const template = await prisma.messageTemplate.findFirst({
        where: { id: templateId, garageId },
      });

      if (!template || !template.metaTemplateId) {
        return res.status(404).json({ error: 'Template not found or not submitted yet' });
      }

      const connection = await prisma.socialMediaConnection.findFirst({
        where: { garageId, platform: 'whatsapp', isActive: true },
      });

      if (!connection) {
        return res.status(400).json({ error: 'No WhatsApp connection found' });
      }

      const metaRes = await fetch(
        `https://graph.facebook.com/v18.0/${template.metaTemplateId}`,
        {
          headers: { Authorization: `Bearer ${connection.accessToken}` },
        }
      );

      const metaData = await metaRes.json();

      if (!metaRes.ok) {
        console.error('[TEMPLATES] Sync error from Meta:', metaData);
        return res.status(400).json({ error: 'Failed to fetch template status from Meta' });
      }

      const metaStatus = String(metaData.status || '').toLowerCase();
      let newStatus = template.status;
      let rejectionReason = template.rejectionReason;

      if (metaStatus === 'approved') {
        newStatus = 'approved';
        rejectionReason = null;
      } else if (metaStatus === 'rejected') {
        newStatus = 'rejected';
        rejectionReason = metaData.rejected_reason || metaData.quality_score?.reasons?.join(', ') || 'Rejected by Meta';
      } else if (metaStatus === 'pending') {
        newStatus = 'pending';
      }

      const updated = await prisma.messageTemplate.update({
        where: { id: templateId },
        data: { status: newStatus, rejectionReason },
      });

      console.log(`[TEMPLATES] Synced: ${template.name} → ${newStatus}`);
      res.json({ success: true, template: updated });
    } catch (error) {
      console.error('[TEMPLATES] Sync error:', error);
      res.status(500).json({ error: 'Failed to sync template status' });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/garages/:garageId/templates/:templateId — Delete a template
// ---------------------------------------------------------------------------
router.delete(
  '/garages/:garageId/templates/:templateId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId, templateId } = req.params;

      const template = await prisma.messageTemplate.findFirst({
        where: { id: templateId, garageId },
      });

      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }

      // If submitted to Meta, also delete from Meta
      if (template.metaTemplateId) {
        const connection = await prisma.socialMediaConnection.findFirst({
          where: { garageId, platform: 'whatsapp', isActive: true },
        });

        if (connection) {
          const wabaId = await getWhatsAppBusinessAccountId(connection.accessToken);
          if (wabaId) {
            try {
              await fetch(
                `https://graph.facebook.com/v18.0/${wabaId}/message_templates?name=${template.name}`,
                {
                  method: 'DELETE',
                  headers: { Authorization: `Bearer ${connection.accessToken}` },
                }
              );
              console.log(`[TEMPLATES] Deleted from Meta: ${template.name}`);
            } catch (e) {
              console.warn(`[TEMPLATES] Failed to delete from Meta (non-fatal):`, e);
            }
          }
        }
      }

      await prisma.messageTemplate.delete({ where: { id: templateId } });
      console.log(`[TEMPLATES] Deleted: ${template.name}`);
      res.json({ success: true });
    } catch (error) {
      console.error('[TEMPLATES] Delete error:', error);
      res.status(500).json({ error: 'Failed to delete template' });
    }
  }
);

// ---------------------------------------------------------------------------
// Helper: Get WhatsApp Business Account ID from access token
// ---------------------------------------------------------------------------
async function getWhatsAppBusinessAccountId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      'https://graph.facebook.com/v18.0/me/businesses',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    const businesses = data.data || [];
    if (businesses.length === 0) return null;

    // Get WABA from the first business
    const bizId = businesses[0].id;
    const wabaRes = await fetch(
      `https://graph.facebook.com/v18.0/${bizId}/owned_whatsapp_business_accounts`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const wabaData = await wabaRes.json();
    return wabaData.data?.[0]?.id || null;
  } catch (e) {
    console.error('[TEMPLATES] Failed to get WABA ID:', e);
    return null;
  }
}

export default router;
