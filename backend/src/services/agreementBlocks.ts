// Turn the agreement HTML into flat blocks a PDF can draw.
//
// WHY THIS EXISTS: the clause text used to be typed out twice — once in agreementTemplate.ts
// (what the customer signs) and again in agreementPdf.ts (what we email them). They drifted, and
// nobody noticed: the HTML said a 3-month Proof Period then a 12-month minimum term with no
// termination for convenience, while the PDF said "a rolling monthly term" that either party
// could exit after 3 months. The customer keeps the PDF.
//
// So there is now ONE copy of the words — the HTML — and the PDF is a rendering of it. Better
// still, the PDF renders the SIGNED SNAPSHOT, so it is literally the document they agreed to.
//
// The parser only has to cope with the tags the template actually emits: section, h2, p, strong,
// em, ul, ol, li. It is deliberately not a general HTML parser — if the template ever grows a
// tag this doesn't know, blocksFromAgreementHtml throws rather than silently dropping a clause
// from a contract.

export type Run = { text: string; bold?: boolean; italic?: boolean };

export type Block =
  | { t: 'heading'; text: string }
  | { t: 'para'; runs: Run[] }
  | { t: 'bullets'; items: Run[][] }
  | { t: 'alpha'; items: Run[][] };

const ENTITIES: Record<string, string> = {
  '&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’',
  '&mdash;': '—', '&ndash;': '–', '&nbsp;': ' ', '&pound;': '£',
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
};

function decode(s: string): string {
  return s.replace(/&[a-z#0-9]+;/gi, (m) => {
    if (ENTITIES[m]) return ENTITIES[m];
    const num = m.match(/^&#(\d+);$/);
    return num ? String.fromCharCode(Number(num[1])) : m;
  });
}

/**
 * Inline markup -> runs. Only <strong> and <em> exist inside the contract's paragraphs; anything
 * else would be a template change this file hasn't been taught about.
 */
function runs(html: string): Run[] {
  const out: Run[] = [];
  // Split on the inline tags, keeping them, so we can track bold/italic depth.
  const parts = html.split(/(<\/?(?:strong|em|b|i)>)/i);
  let bold = 0;
  let italic = 0;
  for (const part of parts) {
    if (!part) continue;
    const tag = part.match(/^<(\/?)(strong|em|b|i)>$/i);
    if (tag) {
      const closing = tag[1] === '/';
      const isBold = /^(strong|b)$/i.test(tag[2]);
      if (isBold) bold += closing ? -1 : 1;
      else italic += closing ? -1 : 1;
      continue;
    }
    if (/<[a-z]/i.test(part)) {
      throw new Error(`agreement HTML: unexpected tag inside a paragraph: ${part.slice(0, 60)}`);
    }
    const text = decode(part);
    if (!text) continue;
    out.push({ text, ...(bold > 0 ? { bold: true } : {}), ...(italic > 0 ? { italic: true } : {}) });
  }
  // Collapse the whitespace the HTML source indents with, without gluing words together.
  return out
    .map((r) => ({ ...r, text: r.text.replace(/\s+/g, ' ') }))
    .filter((r) => r.text !== '');
}

function listItems(inner: string): Run[][] {
  const items: Run[][] = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) items.push(runs(m[1]));
  return items;
}

/**
 * Parse the rendered agreement into blocks. Throws rather than guessing — a contract that
 * silently loses a clause because a tag was unrecognised is worse than one that fails to render.
 */
export function blocksFromAgreementHtml(html: string): Block[] {
  // Drop the document header (title/logo/parties table) — the PDF draws its own.
  const body = html.replace(/<header[\s\S]*?<\/header>/i, '');

  const blocks: Block[] = [];
  const sectionRe = /<section[^>]*>([\s\S]*?)<\/section>/gi;
  let sec: RegExpExecArray | null;
  let found = 0;
  while ((sec = sectionRe.exec(body))) {
    found += 1;
    const inner = sec[1];
    // Walk the section's children in document order.
    const nodeRe = /<(h2|p|ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi;
    let node: RegExpExecArray | null;
    while ((node = nodeRe.exec(inner))) {
      const [, tag, content] = node;
      switch (tag.toLowerCase()) {
        case 'h2':
          blocks.push({ t: 'heading', text: decode(content.replace(/<[^>]+>/g, '')).trim() });
          break;
        case 'p': {
          const r = runs(content);
          if (r.length) blocks.push({ t: 'para', runs: r });
          break;
        }
        case 'ul':
          blocks.push({ t: 'bullets', items: listItems(content) });
          break;
        case 'ol':
          blocks.push({ t: 'alpha', items: listItems(content) });
          break;
      }
    }
  }

  if (!found) throw new Error('agreement HTML: no <section> clauses found — refusing to render an empty contract');
  return blocks;
}
