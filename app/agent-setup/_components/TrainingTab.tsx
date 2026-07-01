'use client';

import { useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentConfiguration, AgentKnowledgeDocument } from '../../types';
import {
  fetchAgentConfiguration,
  uploadKnowledgeDocument,
  deleteKnowledgeDocument,
  uploadTyresoftServicesCsv,
  deleteTyresoftServicesCsv,
} from '../../lib/api';
import { getGarageId } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

// Knowledge-base documents (price lists, brochures, service menus, uploaded PDFs/Word/CSV/Excel) plus
// whatever was learned from the website. These aren't part of the AgentConfiguration save flow — they
// go through the knowledge-upload endpoints and are retrieved per-call by the agent's RAG (no prompt
// bloat). The "Give prices on calls" toggle reveals either a price-list file upload (Assist) or the
// structured per-service bracket editor (Tyresoft).
export default function TrainingTab({ config, save, isSaving }: Props) {
  const garageId = getGarageId();
  const queryClient = useQueryClient();
  const toast = useToast();

  const { data } = useQuery({
    enabled: Boolean(garageId),
    queryKey: ['agent-config', garageId],
    queryFn: async () => fetchAgentConfiguration(garageId ?? undefined),
  });
  const knowledgeBase: AgentKnowledgeDocument[] = data?.knowledgeBase ?? [];

  const applyKb = (kb: AgentKnowledgeDocument[]) =>
    queryClient.setQueryData(['agent-config', garageId], (old: unknown) => ({
      ...((old as Record<string, unknown>) ?? {}),
      knowledgeBase: kb,
    }));

  const uploadMut = useMutation({
    mutationFn: (p: { file: File; kind: 'document' | 'price-list' }) =>
      uploadKnowledgeDocument(p.file, p.kind, garageId ?? undefined),
    onSuccess: (d, v) => {
      applyKb(d.knowledgeBase);
      toast.success(
        v.kind === 'price-list' ? 'Price list added' : 'Document added',
        'The agent can use it on calls.',
      );
    },
    onError: (e: unknown) =>
      toast.error('Upload failed', e instanceof Error ? e.message : 'Please try again.'),
  });

  const deleteMut = useMutation({
    mutationFn: (uploadId: string) => deleteKnowledgeDocument(uploadId, garageId ?? undefined),
    onSuccess: (d) => applyKb(d.knowledgeBase),
    onError: (e: unknown) =>
      toast.error('Remove failed', e instanceof Error ? e.message : 'Please try again.'),
  });

  // Tyresoft Services.csv upload — parses the standard Tyresoft services export
  // into tsServices + pricingRules and replaces the garage's pricing in one shot.
  const servicesCsvMut = useMutation({
    mutationFn: (file: File) => uploadTyresoftServicesCsv(file, garageId ?? undefined),
    onSuccess: (d) => {
      void queryClient.invalidateQueries({ queryKey: ['agent-config', garageId] });
      const warnSuffix = d.warnings.length ? ` (${d.warnings.length} row${d.warnings.length === 1 ? '' : 's'} skipped)` : '';
      toast.success(
        'Price list imported',
        `${d.imported.services} services, ${d.imported.brackets} brackets${warnSuffix}.`,
      );
    },
    onError: (e: unknown) =>
      toast.error('Import failed', e instanceof Error ? e.message : 'Please check the CSV format.'),
  });
  // Toggle-off path: clear the uploaded CSV so the agent stops quoting old prices.
  const deleteCsvMut = useMutation({
    mutationFn: () => deleteTyresoftServicesCsv(garageId ?? undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-config', garageId] });
    },
    onError: (e: unknown) =>
      toast.error('Could not remove price list', e instanceof Error ? e.message : 'Please try again.'),
  });

  // One row per uploaded file (chunks share an uploadId).
  const uploadedDocs = useMemo(() => {
    const groups = new Map<string, { uploadId: string; fileName: string; kind: string; chunks: number }>();
    for (const doc of knowledgeBase) {
      if (doc.source !== 'document' && doc.source !== 'price-list') continue;
      const meta = (doc.metadata ?? {}) as { uploadId?: string; fileName?: string; kind?: string };
      const uploadId = meta.uploadId ?? doc.id;
      const existing = groups.get(uploadId);
      if (existing) {
        existing.chunks += 1;
      } else {
        groups.set(uploadId, {
          uploadId,
          fileName: meta.fileName ?? doc.title ?? 'Document',
          kind: meta.kind ?? doc.source,
          chunks: 1,
        });
      }
    }
    return Array.from(groups.values());
  }, [knowledgeBase]);

  const websitePages = knowledgeBase.filter((d) => d.source === 'website-scan').length;
  const isAssist = config.agentType === 'assist';
  const isTyresoftAgent = config.agentScript === 'tyresoft-agent';
  const hasPriceList = uploadedDocs.some((d) => d.kind === 'price-list');
  const hasTyresoftRules =
    Object.keys(config.tyresoftSettings?.pricingRules ?? {}).length > 0;
  // null = no explicit user choice → fall back to derived (on if data exists).
  // true/false = user has clicked the toggle and that wins until they click again.
  const [userPricesPref, setUserPricesPref] = useState<boolean | null>(null);
  // Show/hide the read-only view of what the uploaded Tyresoft price list actually
  // contains (so staff can check it without re-downloading/replacing the CSV).
  const [showPriceList, setShowPriceList] = useState(false);
  const hasAnyPriceData = hasPriceList || (isTyresoftAgent && hasTyresoftRules);
  const showPriceUpload = userPricesPref !== null ? userPricesPref : hasAnyPriceData;

  const onPick = (kind: 'document' | 'price-list') => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) uploadMut.mutate({ file, kind });
  };
  const togglePrices = (next: boolean) => {
    setUserPricesPref(next);
    // For Assist, untick deletes the uploaded price-list files (legacy behavior).
    // For Tyresoft, the toggle is UI-only — the uploaded CSV persists so the user
    // can re-tick later without losing it. To remove it permanently, replace with
    // a different CSV or use the Remove action (TODO).
    if (!next && isAssist) {
      uploadedDocs.filter((d) => d.kind === 'price-list').forEach((d) => deleteMut.mutate(d.uploadId));
    }
  };

  return (
    <TabShell
      title="Training"
      description="Upload your price list, service menu or brochures so the agent can answer detailed questions about what you offer."
      onSave={() => {}}
      isSaving={false}
      saveDisabled
    >
      {/* Documents */}
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Documents</h3>
        <p className="mt-1 text-xs text-slate-500">
          PDF, Word, CSV, Excel or text. The agent reads only the relevant part during a call, so large files won&rsquo;t slow it down.
        </p>
        <label className="mt-3 inline-flex cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-brand-500 hover:text-brand-700">
          {uploadMut.isPending ? 'Uploading…' : '+ Upload document'}
          <input
            type="file"
            accept=".pdf,.doc,.docx,.csv,.xls,.xlsx,.txt,.md"
            className="hidden"
            disabled={uploadMut.isPending}
            onChange={onPick('document')}
          />
        </label>
      </div>

      {/* Give prices on calls (Assist → file upload, Tyresoft → structured editor) */}
      {(isAssist || isTyresoftAgent) ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={showPriceUpload}
              disabled={deleteMut.isPending || deleteCsvMut.isPending}
              onChange={(e) => togglePrices(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 accent-brand-600"
            />
            <span className="text-sm font-medium text-slate-900">Give prices on calls</span>
          </label>
          <p className="mt-1.5 pl-7 text-xs text-slate-500">
            {showPriceUpload
              ? isTyresoftAgent
                ? 'Upload your Tyresoft Services CSV. The agent quotes ONLY these figures, never an invented price. Replace the CSV any time prices change.'
                : 'Upload a price list — the agent quotes ONLY the figures in it, never an invented price.'
              : isTyresoftAgent
                ? 'Off by default. Turn on to upload your Tyresoft price list as a CSV.'
                : 'Off by default. Turn on to upload a price list the agent can quote from. Turning it off removes any uploaded price list.'}
          </p>
          {showPriceUpload ? (
            isTyresoftAgent ? (
              (() => {
                const upload = config.tyresoftSettings?.tsServicesUpload;
                const uploadedAt = upload
                  ? new Date(upload.uploadedAt).toLocaleString('en-GB', {
                      day: 'numeric', month: 'short', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })
                  : null;
                const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) servicesCsvMut.mutate(file);
                };
                return (
                  <div className="mt-3 rounded-md border border-dashed border-brand-300 bg-brand-50 p-3">
                    {upload ? (
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-brand-800">
                            Current price list: <span className="font-semibold">{upload.fileName}</span>
                          </p>
                          <p className="mt-0.5 text-[11px] text-slate-600">
                            Imported {uploadedAt} · {upload.services} service{upload.services === 1 ? '' : 's'} · {upload.brackets} bracket{upload.brackets === 1 ? '' : 's'}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setShowPriceList((v) => !v)}
                            className="inline-flex items-center rounded-md border border-brand-300 bg-white px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100"
                          >
                            {showPriceList ? 'Hide' : 'View'}
                          </button>
                          <label className="inline-flex cursor-pointer items-center rounded-md border border-brand-300 bg-white px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100">
                            {servicesCsvMut.isPending ? 'Replacing…' : 'Replace CSV'}
                            <input type="file" accept=".csv,text/csv" className="hidden" disabled={servicesCsvMut.isPending} onChange={handleFile} />
                          </label>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <p className="text-xs font-medium text-brand-800">No price list yet</p>
                        <p className="mt-0.5 text-[11px] text-slate-600">
                          Upload the standard Tyresoft Services CSV. Engine-size rows are auto-grouped into brackets.
                        </p>
                        <label className="mt-2 inline-flex cursor-pointer items-center rounded-md border border-brand-300 bg-white px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100">
                          {servicesCsvMut.isPending ? 'Importing…' : '+ Upload Services CSV'}
                          <input type="file" accept=".csv,text/csv" className="hidden" disabled={servicesCsvMut.isPending} onChange={handleFile} />
                        </label>
                      </div>
                    )}
                    {upload && showPriceList ? (
                      <div className="mt-3 border-t border-brand-200 pt-3">
                        <table className="w-full text-left text-[11px]">
                          <thead>
                            <tr className="text-slate-500">
                              <th className="pb-1 pr-2 font-medium">Service</th>
                              <th className="pb-1 pr-2 font-medium">Price</th>
                              <th className="pb-1 font-medium">API ID</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(config.tyresoftSettings?.tsServices ?? []).map((svc) => {
                              const brackets = config.tyresoftSettings?.pricingRules?.[svc.id] ?? [];
                              return (
                                <tr key={svc.id} className="border-t border-brand-100 align-top">
                                  <td className="py-1 pr-2 text-slate-800">{svc.name}</td>
                                  <td className="py-1 pr-2 text-slate-700">
                                    {svc.pricingType === 'engine-size' && brackets.length ? (
                                      brackets.map((b, i) => (
                                        <div key={i}>up to {b.maxCC}cc — £{b.price}</div>
                                      ))
                                    ) : typeof svc.price === 'number' ? (
                                      `£${svc.price}`
                                    ) : (
                                      <span className="text-slate-400">no set price</span>
                                    )}
                                  </td>
                                  <td className="py-1 text-slate-500">
                                    {svc.tsServiceId ?? <span className="text-slate-300">—</span>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                );
              })()
            ) : (
              <label className="mt-3 inline-flex cursor-pointer items-center rounded-md border border-brand-300 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-100">
                {uploadMut.isPending ? 'Uploading…' : '+ Upload price list'}
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.csv,.xls,.xlsx,.txt,.md"
                  className="hidden"
                  disabled={uploadMut.isPending}
                  onChange={onPick('price-list')}
                />
              </label>
            )
          ) : null}
        </div>
      ) : null}

      {/* What's in the knowledge base */}
      <div>
        <h3 className="text-sm font-semibold text-slate-900">In the knowledge base</h3>
        {uploadedDocs.length ? (
          <ul className="mt-2 space-y-2">
            {uploadedDocs.map((doc) => (
              <li
                key={doc.uploadId}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-800">{doc.fileName}</p>
                  <p className="text-[11px] text-slate-400">
                    {doc.kind === 'price-list' ? 'Price list' : 'Document'} · {doc.chunks} section{doc.chunks === 1 ? '' : 's'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => deleteMut.mutate(doc.uploadId)}
                  disabled={deleteMut.isPending}
                  className="shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 transition hover:border-rose-400 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-slate-500">No documents uploaded yet.</p>
        )}
        {websitePages > 0 ? (
          <p className="mt-3 text-xs text-slate-500">
            Plus {websitePages} page{websitePages === 1 ? '' : 's'} learned automatically from your website.
          </p>
        ) : null}
      </div>
    </TabShell>
  );
}
