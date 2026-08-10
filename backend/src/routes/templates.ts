import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { getTemplateToken } from '../services/metaTemplateToken.js';

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
        headerSample,
        bodyText,
        variableSamples,
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
          headerSample: headerSample || null,
          bodyText,
          variableSamples: variableSamples || null,
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
// PUT /api/garages/:garageId/templates/:templateId — Update a template
// ---------------------------------------------------------------------------
router.put(
  '/garages/:garageId/templates/:templateId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId, templateId } = req.params;
      const {
        category,
        language,
        headerType,
        headerContent,
        headerSample,
        bodyText,
        variableSamples,
        footerText,
        buttonType,
        buttonText,
        buttonValue,
      } = req.body;

      const template = await prisma.messageTemplate.findFirst({
        where: { id: templateId, garageId },
      });

      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }

      if (!bodyText) {
        return res.status(400).json({ error: 'bodyText is required' });
      }

      // Editing resets the template to draft so it must be resubmitted to Meta
      const updated = await prisma.messageTemplate.update({
        where: { id: templateId },
        data: {
          category: category || template.category,
          language: language || template.language,
          headerType: headerType ?? template.headerType,
          headerContent: headerContent ?? template.headerContent,
          headerSample: headerSample ?? template.headerSample,
          bodyText,
          variableSamples: variableSamples ?? template.variableSamples,
          footerText: footerText ?? template.footerText,
          buttonType: buttonType ?? template.buttonType,
          buttonText: buttonText ?? template.buttonText,
          buttonValue: buttonValue ?? template.buttonValue,
          status: 'draft',
          metaTemplateId: null,
          rejectionReason: null,
        },
      });

      console.log(`[TEMPLATES] Updated: ${template.name} → draft`);
      res.json({ success: true, template: updated });
    } catch (error) {
      console.error('[TEMPLATES] Update error:', error);
      res.status(500).json({ error: 'Failed to update template' });
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
      const wabaId = await getWhatsAppBusinessAccountId(connection.accessToken, connection.whatsappPhoneNumberId || undefined, connection.pageId || undefined);
      if (!wabaId) {
        return res.status(400).json({ error: 'Could not find WhatsApp Business Account. Please reconnect WhatsApp.' });
      }

      // Build the Meta template payload
      const components: any[] = [];

      if (template.headerType === 'text' && template.headerContent) {
        const headerComponent: any = { type: 'HEADER', format: 'TEXT', text: template.headerContent };
        if (/\{\{1\}\}/.test(template.headerContent) && (template as any).headerSample) {
          headerComponent.example = { header_text: [(template as any).headerSample] };
        }
        components.push(headerComponent);
      }

      // Build body component with sample values if provided
      const bodyComponent: any = { type: 'BODY', text: template.bodyText };
      if (template.variableSamples) {
        const samples = template.variableSamples as Record<string, string>;
        const varMatches = [...new Set(template.bodyText.match(/\{\{(\d+)\}\}/g) || [])].sort((a, b) =>
          parseInt(a.replace(/\D/g, '')) - parseInt(b.replace(/\D/g, ''))
        );
        if (varMatches.length > 0) {
          const sampleValues = varMatches.map(v => samples[v] || `sample_${v.replace(/\D/g, '')}`);
          bodyComponent.example = { body_text: [sampleValues] };
        }
      }
      components.push(bodyComponent);

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

      // Template management needs whatsapp_business_management on the WABA. The
      // shared template token has that for ReceptionMate's OWN WABAs — but a
      // garage that brought its own WABA via embedded signup (e.g. EAC Telford)
      // is only manageable with its OWN connection token. So try the shared
      // token first, and on a permission error fall back to the garage's token.
      const primaryToken = getTemplateToken() || connection.accessToken;

      const submitToMeta = async (token: string) => {
        const r = await fetch(
          `https://graph.facebook.com/v18.0/${wabaId}/message_templates`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(metaPayload),
          }
        );
        return { res: r, data: await r.json() };
      };

      let { res: metaRes, data: metaData } = await submitToMeta(primaryToken);

      const isPermissionError =
        metaData?.error?.code === 200 ||
        metaData?.error?.code === 10 ||
        /permission/i.test(metaData?.error?.message ?? '');
      if (!metaRes.ok && isPermissionError && connection.accessToken && connection.accessToken !== primaryToken) {
        console.warn(`[TEMPLATES] Shared template token hit a permission error on WABA ${wabaId} — retrying with the garage's own connection token`);
        ({ res: metaRes, data: metaData } = await submitToMeta(connection.accessToken));
      }

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
          headers: { Authorization: `Bearer ${getTemplateToken() || connection.accessToken}` },
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
          const wabaId = await getWhatsAppBusinessAccountId(connection.accessToken, connection.whatsappPhoneNumberId || undefined, connection.pageId || undefined);
          if (wabaId) {
            try {
              await fetch(
                `https://graph.facebook.com/v18.0/${wabaId}/message_templates?name=${template.name}`,
                {
                  method: 'DELETE',
                  headers: { Authorization: `Bearer ${getTemplateToken() || connection.accessToken}` },
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
// Helper: Get WhatsApp Business Account ID
// pageId on the WhatsApp SocialMediaConnection stores the WABA ID directly.
// Falls back to Meta API lookup if not set.
// ---------------------------------------------------------------------------
async function getWhatsAppBusinessAccountId(accessToken: string, phoneNumberId?: string, wabaId?: string): Promise<string | null> {
  // Primary: use stored WABA ID (most reliable — no API call needed)
  if (wabaId) {
    console.log(`[TEMPLATES] Using stored WABA ID: ${wabaId}`);
    return wabaId;
  }

  // Secondary: derive from phone number ID
  if (phoneNumberId && phoneNumberId !== 'pending_setup') {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v18.0/${phoneNumberId}?fields=whatsapp_business_account`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await res.json();
      if (data.whatsapp_business_account?.id) {
        console.log(`[TEMPLATES] Got WABA ID from phone number: ${data.whatsapp_business_account.id}`);
        return data.whatsapp_business_account.id;
      }
      console.warn('[TEMPLATES] Phone number lookup returned no WABA:', JSON.stringify(data));
    } catch (e) {
      console.warn('[TEMPLATES] Failed to get WABA from phone number ID:', e);
    }
  }

  // Fallback: /me/businesses (works with user tokens)
  try {
    const res = await fetch(
      'https://graph.facebook.com/v18.0/me/businesses',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    const businesses = data.data || [];
    if (businesses.length === 0) return null;

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
