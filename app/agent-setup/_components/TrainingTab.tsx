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
import { useLang } from '@/app/i18n/LocaleProvider';
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
  const lang = useLang();
  const c = {
    en: {
      title: 'Training',
      description:
        'Upload your price list, service menu or brochures so the agent can answer detailed questions about what you offer.',
      priceListAdded: 'Price list added',
      documentAdded: 'Document added',
      canUseOnCalls: 'The agent can use it on calls.',
      uploadFailed: 'Upload failed',
      tryAgain: 'Please try again.',
      removeFailed: 'Remove failed',
      priceListImported: 'Price list imported',
      importSummary: (services: number, brackets: number, warnSuffix: string) =>
        `${services} services, ${brackets} brackets${warnSuffix}.`,
      rowsSkipped: (n: number) => ` (${n} row${n === 1 ? '' : 's'} skipped)`,
      importFailed: 'Import failed',
      checkCsv: 'Please check the CSV format.',
      couldNotRemovePriceList: 'Could not remove price list',
      documentsHeading: 'Documents',
      documentsBlurb:
        'PDF, Word, CSV, Excel or text. The agent reads only the relevant part during a call, so large files won’t slow it down.',
      uploading: 'Uploading…',
      uploadDocument: '+ Upload document',
      givePrices: 'Give prices on calls',
      priceOnTyresoft:
        'Upload your Tyresoft Services CSV. The agent quotes ONLY these figures, never an invented price. Replace the CSV any time prices change.',
      priceOnAssist:
        'Upload a price list — the agent quotes ONLY the figures in it, never an invented price.',
      priceOffTyresoft: 'Off by default. Turn on to upload your Tyresoft price list as a CSV.',
      priceOffAssist:
        'Off by default. Turn on to upload a price list the agent can quote from. Turning it off removes any uploaded price list.',
      currentPriceList: 'Current price list: ',
      importedLine: (uploadedAt: string, services: number, brackets: number) =>
        `Imported ${uploadedAt} · ${services} service${services === 1 ? '' : 's'} · ${brackets} bracket${brackets === 1 ? '' : 's'}`,
      hide: 'Hide',
      view: 'View',
      replacing: 'Replacing…',
      replaceCsv: 'Replace CSV',
      noPriceList: 'No price list yet',
      uploadStandardCsv:
        'Upload the standard Tyresoft Services CSV. Engine-size rows are auto-grouped into brackets.',
      importing: 'Importing…',
      uploadServicesCsv: '+ Upload Services CSV',
      colService: 'Service',
      colPrice: 'Price',
      colApiId: 'API ID',
      upToCc: (maxCC: number, price: number | string) => `up to ${maxCC}cc — £${price}`,
      noSetPrice: 'no set price',
      uploadPriceList: '+ Upload price list',
      inKbHeading: 'In the knowledge base',
      docKindPriceList: 'Price list',
      docKindDocument: 'Document',
      sectionsLine: (chunks: number) => `${chunks} section${chunks === 1 ? '' : 's'}`,
      remove: 'Remove',
      noDocsYet: 'No documents uploaded yet.',
      websiteLine: (pages: number) =>
        `Plus ${pages} page${pages === 1 ? '' : 's'} learned automatically from your website.`,
    },
    fr: {
      title: 'Formation',
      description:
        "Téléversez votre liste de prix, votre menu de prestations ou vos brochures pour que l'agent puisse répondre aux questions détaillées sur ce que vous proposez.",
      priceListAdded: 'Liste de prix ajoutée',
      documentAdded: 'Document ajouté',
      canUseOnCalls: "L'agent peut l'utiliser lors des appels.",
      uploadFailed: 'Échec du téléversement',
      tryAgain: 'Veuillez réessayer.',
      removeFailed: 'Échec de la suppression',
      priceListImported: 'Liste de prix importée',
      importSummary: (services: number, brackets: number, warnSuffix: string) =>
        `${services} prestations, ${brackets} tranches${warnSuffix}.`,
      rowsSkipped: (n: number) => ` (${n} ligne${n === 1 ? '' : 's'} ignorée${n === 1 ? '' : 's'})`,
      importFailed: 'Échec de l’import',
      checkCsv: 'Veuillez vérifier le format du CSV.',
      couldNotRemovePriceList: 'Impossible de supprimer la liste de prix',
      documentsHeading: 'Documents',
      documentsBlurb:
        "PDF, Word, CSV, Excel ou texte. L'agent ne lit que la partie pertinente pendant un appel, les gros fichiers ne le ralentiront donc pas.",
      uploading: 'Téléversement…',
      uploadDocument: '+ Téléverser un document',
      givePrices: 'Donner les prix lors des appels',
      priceOnTyresoft:
        "Téléversez votre CSV Services Tyresoft. L'agent ne cite QUE ces chiffres, jamais un prix inventé. Remplacez le CSV chaque fois que les prix changent.",
      priceOnAssist:
        "Téléversez une liste de prix — l'agent ne cite QUE les chiffres qui s'y trouvent, jamais un prix inventé.",
      priceOffTyresoft:
        'Désactivé par défaut. Activez pour téléverser votre liste de prix Tyresoft au format CSV.',
      priceOffAssist:
        "Désactivé par défaut. Activez pour téléverser une liste de prix que l'agent peut citer. Le désactiver supprime toute liste de prix téléversée.",
      currentPriceList: 'Liste de prix actuelle : ',
      importedLine: (uploadedAt: string, services: number, brackets: number) =>
        `Importée ${uploadedAt} · ${services} prestation${services === 1 ? '' : 's'} · ${brackets} tranche${brackets === 1 ? '' : 's'}`,
      hide: 'Masquer',
      view: 'Voir',
      replacing: 'Remplacement…',
      replaceCsv: 'Remplacer le CSV',
      noPriceList: 'Pas encore de liste de prix',
      uploadStandardCsv:
        'Téléversez le CSV Services Tyresoft standard. Les lignes par cylindrée sont automatiquement regroupées en tranches.',
      importing: 'Import…',
      uploadServicesCsv: '+ Téléverser le CSV Services',
      colService: 'Prestation',
      colPrice: 'Prix',
      colApiId: 'ID API',
      upToCc: (maxCC: number, price: number | string) => `jusqu’à ${maxCC}cc — £${price}`,
      noSetPrice: 'pas de prix défini',
      uploadPriceList: '+ Téléverser une liste de prix',
      inKbHeading: 'Dans la base de connaissances',
      docKindPriceList: 'Liste de prix',
      docKindDocument: 'Document',
      sectionsLine: (chunks: number) => `${chunks} section${chunks === 1 ? '' : 's'}`,
      remove: 'Supprimer',
      noDocsYet: 'Aucun document téléversé pour l’instant.',
      websiteLine: (pages: number) =>
        `Plus ${pages} page${pages === 1 ? '' : 's'} apprise${pages === 1 ? '' : 's'} automatiquement depuis votre site web.`,
    },
  }[lang];
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
        v.kind === 'price-list' ? c.priceListAdded : c.documentAdded,
        c.canUseOnCalls,
      );
    },
    onError: (e: unknown) =>
      toast.error(c.uploadFailed, e instanceof Error ? e.message : c.tryAgain),
  });

  const deleteMut = useMutation({
    mutationFn: (uploadId: string) => deleteKnowledgeDocument(uploadId, garageId ?? undefined),
    onSuccess: (d) => applyKb(d.knowledgeBase),
    onError: (e: unknown) =>
      toast.error(c.removeFailed, e instanceof Error ? e.message : c.tryAgain),
  });

  // Tyresoft Services.csv upload — parses the standard Tyresoft services export
  // into tsServices + pricingRules and replaces the garage's pricing in one shot.
  const servicesCsvMut = useMutation({
    mutationFn: (file: File) => uploadTyresoftServicesCsv(file, garageId ?? undefined),
    onSuccess: (d) => {
      void queryClient.invalidateQueries({ queryKey: ['agent-config', garageId] });
      const warnSuffix = d.warnings.length ? c.rowsSkipped(d.warnings.length) : '';
      toast.success(
        c.priceListImported,
        c.importSummary(d.imported.services, d.imported.brackets, warnSuffix),
      );
    },
    onError: (e: unknown) =>
      toast.error(c.importFailed, e instanceof Error ? e.message : c.checkCsv),
  });
  // Toggle-off path: clear the uploaded CSV so the agent stops quoting old prices.
  const deleteCsvMut = useMutation({
    mutationFn: () => deleteTyresoftServicesCsv(garageId ?? undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-config', garageId] });
    },
    onError: (e: unknown) =>
      toast.error(c.couldNotRemovePriceList, e instanceof Error ? e.message : c.tryAgain),
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
          fileName: meta.fileName ?? doc.title ?? c.docKindDocument,
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
      title={c.title}
      description={c.description}
      onSave={() => {}}
      isSaving={false}
      saveDisabled
    >
      {/* Documents */}
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{c.documentsHeading}</h3>
        <p className="mt-1 text-xs text-slate-500">
          {c.documentsBlurb}
        </p>
        <label className="mt-3 inline-flex cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-brand-500 hover:text-brand-700">
          {uploadMut.isPending ? c.uploading : c.uploadDocument}
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
            <span className="text-sm font-medium text-slate-900">{c.givePrices}</span>
          </label>
          <p className="mt-1.5 pl-7 text-xs text-slate-500">
            {showPriceUpload
              ? isTyresoftAgent
                ? c.priceOnTyresoft
                : c.priceOnAssist
              : isTyresoftAgent
                ? c.priceOffTyresoft
                : c.priceOffAssist}
          </p>
          {showPriceUpload ? (
            isTyresoftAgent ? (
              (() => {
                const upload = config.tyresoftSettings?.tsServicesUpload;
                const uploadedAt = upload
                  ? new Date(upload.uploadedAt).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', {
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
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-brand-800">
                            {c.currentPriceList}<span className="font-semibold">{upload.fileName}</span>
                          </p>
                          <p className="mt-0.5 text-[11px] text-slate-600">
                            {c.importedLine(uploadedAt ?? '', upload.services, upload.brackets)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setShowPriceList((v) => !v)}
                            className="inline-flex items-center rounded-md border border-brand-300 bg-white px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100"
                          >
                            {showPriceList ? c.hide : c.view}
                          </button>
                          <label className="inline-flex cursor-pointer items-center rounded-md border border-brand-300 bg-white px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100">
                            {servicesCsvMut.isPending ? c.replacing : c.replaceCsv}
                            <input type="file" accept=".csv,text/csv" className="hidden" disabled={servicesCsvMut.isPending} onChange={handleFile} />
                          </label>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <p className="text-xs font-medium text-brand-800">{c.noPriceList}</p>
                        <p className="mt-0.5 text-[11px] text-slate-600">
                          {c.uploadStandardCsv}
                        </p>
                        <label className="mt-2 inline-flex cursor-pointer items-center rounded-md border border-brand-300 bg-white px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100">
                          {servicesCsvMut.isPending ? c.importing : c.uploadServicesCsv}
                          <input type="file" accept=".csv,text/csv" className="hidden" disabled={servicesCsvMut.isPending} onChange={handleFile} />
                        </label>
                      </div>
                    )}
                    {upload && showPriceList ? (
                      <div className="mt-3 overflow-x-auto border-t border-brand-200 pt-3">
                        <table className="w-full text-left text-[11px]">
                          <thead>
                            <tr className="text-slate-500">
                              <th className="pb-1 pr-2 font-medium">{c.colService}</th>
                              <th className="pb-1 pr-2 font-medium">{c.colPrice}</th>
                              <th className="pb-1 font-medium">{c.colApiId}</th>
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
                                        <div key={i}>{c.upToCc(b.maxCC, b.price)}</div>
                                      ))
                                    ) : typeof svc.price === 'number' ? (
                                      `£${svc.price}`
                                    ) : (
                                      <span className="text-slate-400">{c.noSetPrice}</span>
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
                {uploadMut.isPending ? c.uploading : c.uploadPriceList}
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
        <h3 className="text-sm font-semibold text-slate-900">{c.inKbHeading}</h3>
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
                    {doc.kind === 'price-list' ? c.docKindPriceList : c.docKindDocument} · {c.sectionsLine(doc.chunks)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => deleteMut.mutate(doc.uploadId)}
                  disabled={deleteMut.isPending}
                  className="shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 transition hover:border-rose-400 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {c.remove}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-slate-500">{c.noDocsYet}</p>
        )}
        {websitePages > 0 ? (
          <p className="mt-3 text-xs text-slate-500">
            {c.websiteLine(websitePages)}
          </p>
        ) : null}
      </div>
    </TabShell>
  );
}
