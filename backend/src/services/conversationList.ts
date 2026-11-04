// Shapes a list of ChatConversation rows for the inbox: one card per customer, so a person who
// has written on WhatsApp and Facebook shows once, not twice. Shared by the per-garage list and
// the all-branches inbox, which is why the merge key carries the garage — Customer rows are per
// garage, but two branches could in theory issue the same id, and a sales team reading five
// branches at once must never see one branch's thread folded into another's.

type Row = {
  id: string;
  garageId: string;
  platform: string;
  customerId: string | null;
  customerPhone: string | null;
  customerName: string | null;
  status: string;
  unreadCount: number;
  enquiryType: string | null;
  assigneeId: string | null;
  assignee: { id: string; email: string } | null;
  lastMessageAt: Date;
  messages: { createdAt: Date; [key: string]: unknown }[];
  customer?: { name?: string | null; [key: string]: unknown } | null;
  garage?: { id: string; name: string } | null;
  [key: string]: unknown;
};

// Priority for picking one enquiryType across a merged group. Complaint always wins so a
// customer's complaint on WhatsApp doesn't get hidden by a general Facebook message on the
// same person's card.
const ENQUIRY_PRIORITY: Record<string, number> = {
  complaint: 4, booking: 3, parts: 3, sales: 2, general: 1,
};

const byNewest = <T extends { lastMessageAt: Date }>(a: T, b: T) =>
  new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();

export function mergeConversationsByCustomer<T extends Row>(rows: T[]): Array<T | Record<string, unknown>> {
  const groupedByCustomer = new Map<string, T[]>();
  const withoutCustomer: T[] = [];

  for (const conv of rows) {
    if (conv.customerId) {
      const key = `${conv.garageId}:${conv.customerId}`;
      const existing = groupedByCustomer.get(key) || [];
      existing.push(conv);
      groupedByCustomer.set(key, existing);
    } else {
      withoutCustomer.push(conv);
    }
  }

  const merged: Array<T | Record<string, unknown>> = [];

  for (const convs of groupedByCustomer.values()) {
    if (convs.length === 1) {
      merged.push(convs[0]);
      continue;
    }
    // Dedup platforms so a customer with several WhatsApp-only rows shows one WhatsApp icon,
    // not N copies of it.
    const platforms = Array.from(new Set(convs.map((c) => c.platform)));
    const allMessages = convs.flatMap((c) => c.messages);
    const latestMessage = allMessages.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];
    const totalUnread = convs.reduce((sum, c) => sum + c.unreadCount, 0);
    const latestConv = [...convs].sort(byNewest)[0];

    // Roll up display fields for the merged card: enquiryType is the strongest across the
    // group; assignee is the latest conversation's owner (assignment is per-conversation and
    // the assign action still targets a specific id).
    const rolledEnquiryType = convs.reduce<string | null>((best, c) => {
      const t = c.enquiryType;
      if (!t) return best;
      if (!best) return t;
      return (ENQUIRY_PRIORITY[t] ?? 0) > (ENQUIRY_PRIORITY[best] ?? 0) ? t : best;
    }, null);

    merged.push({
      id: latestConv.id,
      garageId: latestConv.garageId,
      garage: latestConv.garage,
      platform: platforms.join(','), // "whatsapp,facebook,instagram"
      platforms,
      customerPhone: latestConv.customerPhone,
      customerId: latestConv.customerId,
      customer: latestConv.customer,
      customerName: latestConv.customer?.name || latestConv.customerName,
      status: latestConv.status,
      unreadCount: totalUnread,
      enquiryType: rolledEnquiryType,
      assigneeId: latestConv.assigneeId,
      assignee: latestConv.assignee,
      lastMessageAt: latestConv.lastMessageAt,
      messages: [latestMessage],
      conversationIds: convs.map((c) => c.id),
    });
  }

  merged.push(...withoutCustomer);
  merged.sort((a, b) => byNewest(a as { lastMessageAt: Date }, b as { lastMessageAt: Date }));
  return merged;
}

/** Translate the inbox's query-string filters into a Prisma where clause fragment. */
export function conversationFilters(
  query: Record<string, unknown>,
  callerUserId: string | undefined,
): Record<string, unknown> {
  const { platform, status, enquiryType, assigneeId } = query;
  const where: Record<string, unknown> = {};
  if (typeof platform === 'string' && platform && platform !== 'all') where.platform = platform;
  if (typeof status === 'string' && status && status !== 'all') where.status = status;
  if (typeof enquiryType === 'string' && enquiryType && enquiryType !== 'all') where.enquiryType = enquiryType;
  // "mine" resolves to the caller's userId. "unassigned" filters the shared pool. Anything else
  // is treated as a literal userId.
  if (assigneeId === 'mine') {
    where.assigneeId = callerUserId ?? null;
  } else if (assigneeId === 'unassigned') {
    where.assigneeId = null;
  } else if (typeof assigneeId === 'string' && assigneeId && assigneeId !== 'all') {
    where.assigneeId = assigneeId;
  }
  return where;
}

/**
 * `garageIds` arrives either repeated (`?garageIds=a&garageIds=b`) or comma-joined. Express's
 * qs parser turns more than 20 repeats into an object, so comma-joined is what the portal sends
 * and repeats are accepted for hand-written calls.
 */
export function parseGarageIds(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const ids = parts.map((p) => String(p).trim()).filter((p) => /^[0-9a-f-]{36}$/i.test(p));
  return Array.from(new Set(ids));
}
