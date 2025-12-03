import { load } from 'cheerio';

const PHONE_REGEX = /\+?\d[\d\s().-]{6,}/g;
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const WEEKDAY_NAMES = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const BLOCKED_EXTENSIONS = new Set([
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'svg',
  'webp',
  'mp4',
  'mp3',
  'mov',
  'avi',
  'zip',
  'rar',
  'gz',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'ics',
  'json',
  'xml',
  'txt',
  'csv',
]);

export interface WebsiteScanResult {
  title?: string;
  description?: string;
  phoneNumbers: string[];
  emails: string[];
  address?: string;
  hours: string[];
  rawSnippet?: string;
  knowledgeChunks: string[];
}

export interface WebsitePageAnalysis extends WebsiteScanResult {
  url: string;
  links: string[];
}

export interface WebsiteScanSummaryPage {
  url: string;
  title?: string;
  description?: string;
  snippet?: string;
  phoneNumbers: string[];
  emails: string[];
  hours: string[];
  address?: string;
  chunkCount: number;
}

export interface WebsiteScanDiscovery {
  origin: string;
  pages: WebsiteScanSummaryPage[];
}

const normaliseLine = (value: string) => value.replace(/\s+/g, ' ').trim();

const stripTrailingSlash = (path: string) => {
  if (path === '/') {
    return '/';
  }
  const trimmed = path.replace(/\/+$/, '');
  return trimmed || '/';
};

const normaliseUrl = (input: URL) => {
  const url = new URL(input.toString());
  url.hash = '';
  url.pathname = stripTrailingSlash(url.pathname);
  url.searchParams.sort();
  return url;
};

const extractAddress = ($: ReturnType<typeof load>) => {
  const addressElement = $('address').first();
  if (addressElement.length > 0) {
    return normaliseLine(addressElement.text());
  }

  const schemaAddress = $('script[type="application/ld+json"]').toArray()
    .map((script) => $(script).text())
    .map((content) => {
      try {
        return JSON.parse(content);
      } catch {
        return null;
      }
    })
    .filter((data) => data && typeof data === 'object') as Array<Record<string, unknown>>;

  for (const entry of schemaAddress) {
    const postalAddress = entry?.address as Record<string, unknown> | undefined;
    if (postalAddress && typeof postalAddress === 'object') {
      const parts = [
        postalAddress.streetAddress,
        postalAddress.addressLocality,
        postalAddress.addressRegion,
        postalAddress.postalCode,
        postalAddress.addressCountry,
      ]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean);
      if (parts.length > 0) {
        return parts.join(', ');
      }
    }
  }

  return undefined;
};

const extractHours = ($: ReturnType<typeof load>) => {
  const hours: string[] = [];

  $('li, p, span, div').each((_, element) => {
    const text = normaliseLine($(element).text());
    if (!text) {
      return;
    }
    if (WEEKDAY_NAMES.some((day) => text.toLowerCase().startsWith(day))) {
      if (!hours.includes(text)) {
        hours.push(text);
      }
    }
  });

  return hours.slice(0, 14);
};

const MIN_PARAGRAPH_LENGTH = 60;
const MAX_KNOWLEDGE_CHUNKS = 10;
const MAX_CHUNK_LENGTH = 750;

const extractParagraphs = ($: ReturnType<typeof load>) => {
  const sections = ['main p', 'main li', 'body p', 'body li'];
  const seen = new Set<string>();
  const paragraphs: string[] = [];

  for (const selector of sections) {
    $(selector).each((_, element) => {
      const text = normaliseLine($(element).text());
      if (text.length < MIN_PARAGRAPH_LENGTH) {
        return;
      }
      if (seen.has(text)) {
        return;
      }
      seen.add(text);
      paragraphs.push(text);
    });
    if (paragraphs.length >= MAX_KNOWLEDGE_CHUNKS * 2) {
      break;
    }
  }

  return paragraphs;
};

const buildKnowledgeChunks = (paragraphs: string[]) => {
  if (paragraphs.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed.length >= MIN_PARAGRAPH_LENGTH) {
      chunks.push(trimmed);
    }
    current = '';
  };

  for (const paragraph of paragraphs) {
    if ((current + ' ' + paragraph).trim().length > MAX_CHUNK_LENGTH) {
      pushCurrent();
      current = paragraph;
      continue;
    }
    current = current ? `${current} ${paragraph}` : paragraph;
  }

  if (current) {
    pushCurrent();
  }

  return chunks.slice(0, MAX_KNOWLEDGE_CHUNKS);
};

const normaliseCandidateLink = (href: string, baseUrl: URL): string | null => {
  try {
    const candidate = new URL(href, baseUrl);
    if (!['http:', 'https:'].includes(candidate.protocol)) {
      return null;
    }
    if (candidate.hostname !== baseUrl.hostname) {
      return null;
    }
    const extension = candidate.pathname.split('.').pop()?.toLowerCase() ?? '';
    if (extension && BLOCKED_EXTENSIONS.has(extension)) {
      return null;
    }
    const normalized = normaliseUrl(candidate);
    return normalized.toString();
  } catch {
    return null;
  }
};

const extractLinks = ($: ReturnType<typeof load>, baseUrl: URL) => {
  const links = new Set<string>();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) {
      return;
    }
    const normalized = normaliseCandidateLink(href, baseUrl);
    if (normalized) {
      links.add(normalized);
    }
  });
  return Array.from(links);
};

const fetchHtml = async (url: URL) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'user-agent': 'ReceptionMateBot/1.0 (+https://receptionmate.co.uk)',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to load page (status ${response.status})`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
};

const analyseHtml = (url: URL, html: string): WebsitePageAnalysis => {
  const $ = load(html);
  const title = normaliseLine($('title').first().text());
  const description = normaliseLine($('meta[name="description"]').attr('content') ?? '') || undefined;
  const bodyText = normaliseLine($('body').text());

  const phoneNumbers = Array.from(new Set(bodyText.match(PHONE_REGEX)?.map((entry) => entry.trim()) ?? []));
  const emails = Array.from(new Set(bodyText.match(EMAIL_REGEX)?.map((entry) => entry.trim()) ?? []));

  const address = extractAddress($);
  const hours = extractHours($);
  const paragraphs = extractParagraphs($);
  const knowledgeChunks = buildKnowledgeChunks(paragraphs);

  const rawSnippet = bodyText ? bodyText.slice(0, 500) : undefined;
  const links = extractLinks($, url);

  return {
    url: url.toString(),
    title: title || undefined,
    description,
    phoneNumbers,
    emails,
    address,
    hours,
    rawSnippet,
    knowledgeChunks,
    links,
  };
};

export const scrapeWebsitePage = async (inputUrl: string): Promise<WebsitePageAnalysis> => {
  const parsedUrl = new URL(inputUrl);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only HTTP(S) URLs are supported');
  }

  const normalized = normaliseUrl(parsedUrl);
  const html = await fetchHtml(normalized);
  return analyseHtml(normalized, html);
};

export const fetchWebsiteInfo = async (inputUrl: string): Promise<WebsiteScanResult> => {
  const { links, ...rest } = await scrapeWebsitePage(inputUrl);
  void links;
  return rest;
};

const MAX_DISCOVERED_PAGES = 12;
const MAX_LINKS_PER_PAGE = 15;

export const discoverWebsitePages = async (inputUrl: string): Promise<WebsiteScanDiscovery> => {
  const parsedUrl = new URL(inputUrl);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only HTTP(S) URLs are supported');
  }

  const startUrl = normaliseUrl(parsedUrl);
  const queue: string[] = [startUrl.toString()];
  const enqueued = new Set<string>(queue);
  const visited = new Set<string>();
  const pages: WebsiteScanSummaryPage[] = [];

  while (queue.length > 0 && pages.length < MAX_DISCOVERED_PAGES) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    enqueued.delete(current);
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    try {
      const analysis = await scrapeWebsitePage(current);
      pages.push({
        url: analysis.url,
        title: analysis.title,
        description: analysis.description,
        snippet: analysis.rawSnippet ? analysis.rawSnippet.slice(0, 260) : undefined,
        phoneNumbers: analysis.phoneNumbers,
        emails: analysis.emails,
        hours: analysis.hours,
        address: analysis.address,
        chunkCount: analysis.knowledgeChunks.length,
      });

      const nextLinks = analysis.links.slice(0, MAX_LINKS_PER_PAGE);
      for (const link of nextLinks) {
        if (visited.has(link) || enqueued.has(link)) {
          continue;
        }
        const linkUrl = new URL(link);
        if (linkUrl.hostname !== startUrl.hostname) {
          continue;
        }
        queue.push(link);
        enqueued.add(link);
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`Failed to scan page ${current}`, error);
      }
    }
  }

  return {
    origin: startUrl.origin,
    pages,
  };
};
