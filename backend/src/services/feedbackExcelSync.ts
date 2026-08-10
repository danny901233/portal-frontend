/**
 * Negative Feedback → OneDrive Excel Sync
 *
 * Appends new negative-feedback rows to a shared Excel file on OneDrive
 * via Microsoft Graph API. Existing rows (and any manual notes the team
 * added) are never overwritten.
 *
 * Required env vars:
 *   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET,
 *   MS_ONEDRIVE_USER        – e.g. hello@receptionmate.co.uk
 *   MS_FEEDBACK_FILE_ID      – the Graph drive-item id of the Excel file
 *
 * Scheduled by scheduler.ts — runs every 2 hours.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── helpers ──────────────────────────────────────────────────────────

function getConfig() {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const user = process.env.MS_ONEDRIVE_USER;
  const fileId = process.env.MS_FEEDBACK_FILE_ID;

  if (!tenantId || !clientId || !clientSecret || !user || !fileId) {
    return null;
  }
  return { tenantId, clientId, clientSecret, user, fileId };
}

async function getAccessToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });

  if (!resp.ok) {
    throw new Error(`Token request failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

// ── main sync ────────────────────────────────────────────────────────

export async function syncNegativeFeedbackToExcel(): Promise<{
  appended: number;
  skipped: number;
}> {
  const cfg = getConfig();
  if (!cfg) {
    console.log('[FEEDBACK-SYNC] Microsoft Graph env vars not configured — skipping');
    return { appended: 0, skipped: 0 };
  }

  const token = await getAccessToken(cfg.tenantId, cfg.clientId, cfg.clientSecret);
  const base = `https://graph.microsoft.com/v1.0/users/${cfg.user}/drive/items/${cfg.fileId}/workbook`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // 1. Read existing call IDs from column A (Date) + column C (Customer Name)
  //    We use the callId stored in a hidden column (J) to deduplicate.
  //    First, get the used range to know how many rows exist.
  const rangeResp = await fetch(
    `${base}/worksheets/Negative%20Feedback/usedRange?$select=address,rowCount`,
    { headers },
  );

  if (!rangeResp.ok) {
    throw new Error(`Failed to read used range: ${rangeResp.status} ${await rangeResp.text()}`);
  }

  const rangeData = (await rangeResp.json()) as { rowCount: number };
  const existingRowCount = rangeData.rowCount; // includes header

  // Read column J (callId) to know which feedback is already synced
  const existingCallIds = new Set<string>();
  if (existingRowCount > 1) {
    const colResp = await fetch(
      `${base}/worksheets/Negative%20Feedback/range(address='J2:J${existingRowCount}')`,
      { headers },
    );
    if (colResp.ok) {
      const colData = (await colResp.json()) as { values: (string | null)[][] };
      for (const row of colData.values) {
        const val = row[0];
        if (val) existingCallIds.add(String(val));
      }
    }
  }

  // 2. Query new negative feedback from DB
  const feedbacks = await prisma.callFeedback.findMany({
    where: { rating: 'down' },
    include: {
      call: {
        select: {
          id: true,
          createdAt: true,
          customerName: true,
          customerPhone: true,
          registrationNumber: true,
          summary: true,
          callType: true,
          garageId: true,
          garage: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // 3. Filter out already-synced rows
  const newFeedbacks = feedbacks.filter((fb) => !existingCallIds.has(fb.callId));

  if (newFeedbacks.length === 0) {
    console.log('[FEEDBACK-SYNC] No new negative feedback to sync');
    return { appended: 0, skipped: feedbacks.length };
  }

  // 4. Build rows to append
  //    Columns: A=Date, B=Garage, C=Customer Name, D=Phone, E=Registration,
  //             F=Call Type, G=Feedback Reasons, H=Feedback Notes, I=Call Summary,
  //             J=Call ID (hidden — used for dedup), K=Root Cause, L=Fix Applied, M=Status
  const rows = newFeedbacks.map((fb) => {
    const call = fb.call;
    const date = call.createdAt
      ? new Date(call.createdAt).toISOString().replace('T', ' ').slice(0, 16)
      : '';
    const reasons = Array.isArray(fb.reasons)
      ? (fb.reasons as string[]).join('; ')
      : String(fb.reasons ?? '');

    return [
      date,
      call.garage?.name ?? '',
      call.customerName ?? '',
      call.customerPhone ?? '',
      call.registrationNumber ?? '',
      call.callType ?? '',
      reasons,
      fb.notes ?? '',
      call.summary ?? '',
      fb.callId, // column J — dedup key
      '',        // column K — Root Cause (for team to fill)
      '',        // column L — Fix Applied (for team to fill)
      '',        // column M — Status (for team to fill)
    ];
  });

  // 5. Append via Graph API (table add rows or range write)
  const startRow = existingRowCount + 1;
  const endRow = startRow + rows.length - 1;
  const endCol = 'M'; // 13 columns
  const address = `Negative%20Feedback!A${startRow}:${endCol}${endRow}`;

  const writeResp = await fetch(
    `${base}/worksheets/Negative%20Feedback/range(address='A${startRow}:${endCol}${endRow}')`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ values: rows }),
    },
  );

  if (!writeResp.ok) {
    throw new Error(
      `Failed to write rows: ${writeResp.status} ${await writeResp.text()}`,
    );
  }

  console.log(
    `[FEEDBACK-SYNC] ✓ Appended ${rows.length} new rows (total: ${existingRowCount - 1 + rows.length})`,
  );

  return { appended: rows.length, skipped: feedbacks.length - newFeedbacks.length };
}