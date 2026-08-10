// Text extraction + chunking for uploaded knowledge-base documents (PDF / Word / Excel / CSV / text).
// The extracted text is stored as AgentKnowledgeDocument rows (chunked) and retrieved per-call by the
// agents' search_knowledge() RAG, so large files never bloat the prompt.
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { extractText, getDocumentProxy } from 'unpdf';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_CHUNKS = 60;                     // hard cap so one huge file can't flood the KB
const CHUNK_TARGET = 1400;                         // ~chars per chunk (search windows ~700)

export type KnowledgeKind = 'document' | 'price-list';

const SUPPORTED_EXT = new Set(['pdf', 'doc', 'docx', 'csv', 'xls', 'xlsx', 'txt', 'md']);

export function fileExt(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function isSupportedUpload(filename: string): boolean {
  return SUPPORTED_EXT.has(fileExt(filename));
}

export async function extractTextFromFile(buffer: Buffer, filename: string): Promise<string> {
  const ext = fileExt(filename);

  if (ext === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });
    const raw: unknown = (result as { text?: unknown })?.text;
    return (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('\n') : '').trim();
  }

  if (ext === 'docx' || ext === 'doc') {
    const { value } = await mammoth.extractRawText({ buffer });
    return (value || '').trim();
  }

  if (ext === 'xlsx' || ext === 'xls') {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const parts: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
      if (csv.trim()) parts.push(`# ${sheetName}\n${csv.trim()}`);
    }
    return parts.join('\n\n').trim();
  }

  // csv / txt / md / anything else readable as utf-8
  return buffer.toString('utf8').trim();
}

// Split into ~CHUNK_TARGET-char chunks on line boundaries (so a price row / paragraph isn't cut
// mid-line), capped at MAX_CHUNKS.
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const lines = clean.split('\n');
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > CHUNK_TARGET) {
      chunks.push(cur.trim());
      cur = '';
      if (chunks.length >= MAX_CHUNKS) return chunks;
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur.trim() && chunks.length < MAX_CHUNKS) chunks.push(cur.trim());
  return chunks;
}
