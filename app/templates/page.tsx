'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getGarageId, getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';
import { useLang } from '@/app/i18n/LocaleProvider';

interface MessageTemplate {
  id: string;
  name: string;
  category: string;
  language: string;
  headerType: string | null;
  headerContent: string | null;
  headerSample: string | null;
  bodyText: string;
  variableSamples: Record<string, string> | null;
  footerText: string | null;
  buttonType: string | null;
  buttonText: string | null;
  buttonValue: string | null;
  metaTemplateId: string | null;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-500/20 text-slate-600',
  pending: 'bg-yellow-500/20 text-yellow-300',
  approved: 'bg-green-500/20 text-green-300',
  rejected: 'bg-red-500/20 text-red-300',
};

const CATEGORIES = [
  { value: 'UTILITY', label: 'Utility', desc: 'Appointment reminders, order updates' },
  { value: 'MARKETING', label: 'Marketing', desc: 'Promotions, offers, re-engagement' },
];

const VARIABLE_FIELDS = [
  { label: 'Customer Name', sample: 'John Smith', field: 'customer_name' },
  { label: 'MOT Due Date', sample: '15-Apr-26', field: 'mot_due_date' },
  { label: 'Service Due Date', sample: '20-May-26', field: 'service_due_date' },
  { label: 'Vehicle Reg', sample: 'AB12 CDE', field: 'registration' },
  { label: 'Garage Name', sample: 'City Garage', field: 'garage_name' },
  { label: 'Phone Number', sample: '07700 900123', field: 'phone' },
  { label: 'Custom Text', sample: '', field: '' },
];

export default function TemplatesPage() {
  const router = useRouter();
  const lang = useLang();
  const c = {
    en: {
      updateFailed: 'Failed to update template',
      createFailed: 'Failed to create template',
      updatedReset: 'Template updated and reset to draft. Submit it to WhatsApp for approval.',
      createdOk: 'Template created! You can now submit it to WhatsApp for approval.',
      submitMetaFailed: 'Failed to submit to WhatsApp',
      submittedOk: 'Template submitted to WhatsApp for approval!',
      submitFailed: 'Failed to submit template',
      syncFailed: 'Failed to sync status',
      syncFailed2: 'Failed to sync',
      deleteConfirm: 'Are you sure you want to delete this template?',
      deleteFailed: 'Failed to delete template',
      deletedOk: 'Template deleted.',
      title: 'Message Templates',
      subtitle: 'Create WhatsApp message templates for appointment reminders, marketing, and more. Templates must be approved by Meta before use.',
      cancel: 'Cancel',
      newTemplate: '+ New Template',
      editTemplate: 'Edit Template',
      createTemplate: 'Create Template',
      formIntro: 'Fill in the header, body and footer sections of your template.',
      editWarning: "Editing will reset this template to draft. You'll need to resubmit to WhatsApp for approval.",
      templateName: 'Template Name',
      templateNamePlaceholder: 'Enter template name here',
      nameNoChange: 'Template name cannot be changed after creation.',
      nameRules: 'Lowercase, underscores only. No spaces.',
      category: 'Category',
      header: 'Header',
      optional: '(optional)',
      headerPlaceholder: 'Hello there — or use {{1}} for a variable',
      assignVariable: 'Assign variable',
      selectCustomVariable: 'Select custom variable',
      body: 'Body',
      insertVariable: 'Insert variable',
      selectField: 'Select a field',
      eg: 'e.g.',
      useVars: () => `Use {{1}}, {{2}}, etc. for variables.`,
      varsDetected: (n: number) => `${n} variable${n > 1 ? 's' : ''} detected`,
      sampleValues: 'Sample values',
      requiredForMeta: '— required for Meta approval',
      enterSampleValue: 'Enter sample value',
      footer: 'Footer',
      footerPlaceholder: 'Enter footer body here',
      button: 'Button',
      noButton: 'No button',
      urlButton: 'URL button',
      callButton: 'Call button',
      buttonLabel: 'Button label',
      saving: 'Saving...',
      creating: 'Creating...',
      saveChanges: 'Save Changes',
      preview: 'Preview',
      businessName: 'Business Name',
      whatsappBusiness: 'WhatsApp Business',
      messageAppears: 'Your message will appear here...',
      noTemplates: 'No templates yet. Create your first template to get started.',
      rejectedByMeta: 'Rejected by Meta',
      submitting: 'Submitting...',
      submitToWhatsapp: 'Submit to WhatsApp',
      checking: 'Checking...',
      checkStatus: 'Check Status',
      resubmitting: 'Resubmitting...',
      resubmit: 'Resubmit',
      edit: 'Edit',
      del: 'Delete',
      statusLabels: {
        draft: 'draft',
        pending: 'pending',
        approved: 'approved',
        rejected: 'rejected',
      } as Record<string, string>,
      categoryLabels: { UTILITY: 'Utility', MARKETING: 'Marketing' } as Record<string, string>,
      categoryDescs: {
        UTILITY: 'Appointment reminders, order updates',
        MARKETING: 'Promotions, offers, re-engagement',
      } as Record<string, string>,
      fieldLabels: {
        customer_name: 'Customer Name',
        mot_due_date: 'MOT Due Date',
        service_due_date: 'Service Due Date',
        registration: 'Vehicle Reg',
        garage_name: 'Garage Name',
        phone: 'Phone Number',
        '': 'Custom Text',
      } as Record<string, string>,
    },
    fr: {
      updateFailed: 'Échec de la mise à jour du modèle',
      createFailed: 'Échec de la création du modèle',
      updatedReset: 'Modèle mis à jour et réinitialisé en brouillon. Soumettez-le à WhatsApp pour approbation.',
      createdOk: 'Modèle créé ! Vous pouvez maintenant le soumettre à WhatsApp pour approbation.',
      submitMetaFailed: 'Échec de la soumission à WhatsApp',
      submittedOk: 'Modèle soumis à WhatsApp pour approbation !',
      submitFailed: 'Échec de la soumission du modèle',
      syncFailed: 'Échec de la synchronisation du statut',
      syncFailed2: 'Échec de la synchronisation',
      deleteConfirm: 'Êtes-vous sûr de vouloir supprimer ce modèle ?',
      deleteFailed: 'Échec de la suppression du modèle',
      deletedOk: 'Modèle supprimé.',
      title: 'Modèles de message',
      subtitle: 'Créez des modèles de message WhatsApp pour les rappels de rendez-vous, le marketing et plus encore. Les modèles doivent être approuvés par Meta avant utilisation.',
      cancel: 'Annuler',
      newTemplate: '+ Nouveau modèle',
      editTemplate: 'Modifier le modèle',
      createTemplate: 'Créer un modèle',
      formIntro: 'Remplissez les sections en-tête, corps et pied de page de votre modèle.',
      editWarning: 'La modification réinitialisera ce modèle en brouillon. Vous devrez le soumettre à nouveau à WhatsApp pour approbation.',
      templateName: 'Nom du modèle',
      templateNamePlaceholder: 'Saisissez le nom du modèle ici',
      nameNoChange: 'Le nom du modèle ne peut pas être modifié après la création.',
      nameRules: 'Minuscules et traits de soulignement uniquement. Pas d’espaces.',
      category: 'Catégorie',
      header: 'En-tête',
      optional: '(facultatif)',
      headerPlaceholder: 'Bonjour — ou utilisez {{1}} pour une variable',
      assignVariable: 'Attribuer une variable',
      selectCustomVariable: 'Sélectionner une variable personnalisée',
      body: 'Corps',
      insertVariable: 'Insérer une variable',
      selectField: 'Sélectionner un champ',
      eg: 'ex.',
      useVars: () => `Utilisez {{1}}, {{2}}, etc. pour les variables.`,
      varsDetected: (n: number) => `${n} variable${n > 1 ? 's' : ''} détectée${n > 1 ? 's' : ''}`,
      sampleValues: 'Valeurs d’exemple',
      requiredForMeta: '— requis pour l’approbation Meta',
      enterSampleValue: 'Saisissez une valeur d’exemple',
      footer: 'Pied de page',
      footerPlaceholder: 'Saisissez le pied de page ici',
      button: 'Bouton',
      noButton: 'Aucun bouton',
      urlButton: 'Bouton URL',
      callButton: 'Bouton d’appel',
      buttonLabel: 'Libellé du bouton',
      saving: 'Enregistrement...',
      creating: 'Création...',
      saveChanges: 'Enregistrer les modifications',
      preview: 'Aperçu',
      businessName: 'Nom de l’entreprise',
      whatsappBusiness: 'WhatsApp Business',
      messageAppears: 'Votre message apparaîtra ici...',
      noTemplates: 'Aucun modèle pour l’instant. Créez votre premier modèle pour commencer.',
      rejectedByMeta: 'Rejeté par Meta',
      submitting: 'Soumission...',
      submitToWhatsapp: 'Soumettre à WhatsApp',
      checking: 'Vérification...',
      checkStatus: 'Vérifier le statut',
      resubmitting: 'Nouvelle soumission...',
      resubmit: 'Soumettre à nouveau',
      edit: 'Modifier',
      del: 'Supprimer',
      statusLabels: {
        draft: 'brouillon',
        pending: 'en attente',
        approved: 'approuvé',
        rejected: 'rejeté',
      } as Record<string, string>,
      categoryLabels: { UTILITY: 'Utilitaire', MARKETING: 'Marketing' } as Record<string, string>,
      categoryDescs: {
        UTILITY: 'Rappels de rendez-vous, mises à jour de commande',
        MARKETING: 'Promotions, offres, réengagement',
      } as Record<string, string>,
      fieldLabels: {
        customer_name: 'Nom du client',
        mot_due_date: 'Date du contrôle technique',
        service_due_date: 'Date d’entretien',
        registration: 'Immatriculation du véhicule',
        garage_name: 'Nom du garage',
        phone: 'Numéro de téléphone',
        '': 'Texte personnalisé',
      } as Record<string, string>,
    },
  }[lang];
  // VARIABLE_FIELDS keeps stable English labels as internal keys; translate for display only.
  const displayLabel = (englishLabel: string) => {
    const f = VARIABLE_FIELDS.find(vf => vf.label === englishLabel);
    return f ? c.fieldLabels[f.field] : englishLabel;
  };
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formCategory, setFormCategory] = useState('UTILITY');
  const [formBody, setFormBody] = useState('');
  const [formHeader, setFormHeader] = useState('');
  const [formFooter, setFormFooter] = useState('');
  const [formButtonType, setFormButtonType] = useState('none');
  const [formButtonText, setFormButtonText] = useState('');
  const [formButtonValue, setFormButtonValue] = useState('');
  const [formVariableSamples, setFormVariableSamples] = useState<Record<string, string>>({});
  const [formVariableLabels, setFormVariableLabels] = useState<Record<string, string>>({});
  const [formHeaderSample, setFormHeaderSample] = useState('');
  const [formHeaderLabel, setFormHeaderLabel] = useState('');
  const [showVarPicker, setShowVarPicker] = useState(false);
  const [showTagPicker, setShowTagPicker] = useState<string | null>(null); // variable key e.g. '{{1}}'
  const [showHeaderTagPicker, setShowHeaderTagPicker] = useState(false);

  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const varPickerRef = useRef<HTMLDivElement>(null);
  const tagPickerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const headerTagPickerRef = useRef<HTMLDivElement>(null);

  const garageId = typeof window !== 'undefined' ? getGarageId() : null;
  const token = typeof window !== 'undefined' ? getSessionToken() : null;
  const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  useEffect(() => {
    if (!garageId || !token) {
      router.push('/login');
      return;
    }
    fetchTemplates();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (varPickerRef.current && !varPickerRef.current.contains(e.target as Node)) {
        setShowVarPicker(false);
      }
    }
    if (showVarPicker) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showVarPicker]);

  useEffect(() => {
    if (!showTagPicker) return;
    function handleClickOutside(e: MouseEvent) {
      const ref = tagPickerRefs.current[showTagPicker!];
      if (ref && !ref.contains(e.target as Node)) setShowTagPicker(null);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showTagPicker]);

  useEffect(() => {
    if (!showHeaderTagPicker) return;
    function handleClickOutside(e: MouseEvent) {
      if (headerTagPickerRef.current && !headerTagPickerRef.current.contains(e.target as Node)) {
        setShowHeaderTagPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showHeaderTagPicker]);

  async function fetchTemplates() {
    try {
      const res = await fetch(`${API}/api/garages/${garageId}/templates`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.templates) setTemplates(data.templates);
    } catch (e) {
      console.error('Failed to load templates:', e);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const body = JSON.stringify({
      name: formName,
      category: formCategory,
      bodyText: formBody,
      variableSamples: Object.keys(formVariableSamples).length > 0 ? formVariableSamples : null,
      headerType: formHeader ? 'text' : null,
      headerContent: formHeader || null,
      headerSample: formHeaderSample || null,
      footerText: formFooter || null,
      buttonType: formButtonType !== 'none' ? formButtonType : null,
      buttonText: formButtonType !== 'none' ? formButtonText : null,
      buttonValue: formButtonType !== 'none' ? formButtonValue : null,
    });

    const url = editingTemplateId
      ? `${API}/api/garages/${garageId}/templates/${editingTemplateId}`
      : `${API}/api/garages/${garageId}/templates`;
    const method = editingTemplateId ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || (editingTemplateId ? c.updateFailed : c.createFailed));
        return;
      }
      setSuccess(editingTemplateId ? c.updatedReset : c.createdOk);
      setShowForm(false);
      setEditingTemplateId(null);
      resetForm();
      fetchTemplates();
    } catch (e) {
      setError(editingTemplateId ? c.updateFailed : c.createFailed);
    } finally {
      setSubmitting(false);
    }
  }

  function handleEdit(t: MessageTemplate) {
    resetForm();
    setEditingTemplateId(t.id);
    setFormName(t.name);
    setFormCategory(t.category);
    setFormBody(t.bodyText);
    setFormHeader(t.headerContent || '');
    setFormHeaderSample(t.headerSample || '');
    setFormFooter(t.footerText || '');
    setFormButtonType(t.buttonType || 'none');
    setFormButtonText(t.buttonText || '');
    setFormButtonValue(t.buttonValue || '');

    if (t.variableSamples) {
      setFormVariableSamples(t.variableSamples);
      // Reconstruct labels from _field entries
      const labels: Record<string, string> = {};
      for (const [key, fieldKey] of Object.entries(t.variableSamples)) {
        if (key.endsWith('_field')) {
          const varKey = key.replace('_field', '');
          const field = VARIABLE_FIELDS.find(f => f.field === fieldKey);
          if (field) labels[varKey] = field.label;
        }
      }
      setFormVariableLabels(labels);
    }

    setShowForm(true);
    setError(null);
    setSuccess(null);
    setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 50);
  }

  async function handleSubmitToMeta(templateId: string) {
    setError(null);
    setSyncing(templateId);

    try {
      const res = await fetch(`${API}/api/garages/${garageId}/templates/${templateId}/submit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || c.submitMetaFailed);
        return;
      }
      setSuccess(c.submittedOk);
      fetchTemplates();
    } catch (e) {
      setError(c.submitFailed);
    } finally {
      setSyncing(null);
    }
  }

  async function handleSync(templateId: string) {
    setSyncing(templateId);
    try {
      const res = await fetch(`${API}/api/garages/${garageId}/templates/${templateId}/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || c.syncFailed);
        return;
      }
      fetchTemplates();
    } catch (e) {
      setError(c.syncFailed2);
    } finally {
      setSyncing(null);
    }
  }

  async function handleDelete(templateId: string) {
    if (!confirm(c.deleteConfirm)) return;

    try {
      const res = await fetch(`${API}/api/garages/${garageId}/templates/${templateId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError(c.deleteFailed);
        return;
      }
      setSuccess(c.deletedOk);
      fetchTemplates();
    } catch (e) {
      setError(c.deleteFailed);
    }
  }

  function resetForm() {
    setFormName('');
    setFormCategory('UTILITY');
    setFormBody('');
    setFormHeader('');
    setFormFooter('');
    setFormButtonType('none');
    setFormButtonText('');
    setFormButtonValue('');
    setFormVariableSamples({});
    setFormVariableLabels({});
    setFormHeaderSample('');
    setFormHeaderLabel('');
    setEditingTemplateId(null);
  }

  function insertVariable(field: typeof VARIABLE_FIELDS[number]) {
    const textarea = bodyRef.current;
    if (!textarea) return;

    // Determine next variable number
    const existing = [...new Set(formBody.match(/\{\{(\d+)\}\}/g) || [])];
    const usedNums = existing.map(v => parseInt(v.replace(/\D/g, '')));
    const nextNum = usedNums.length > 0 ? Math.max(...usedNums) + 1 : 1;
    const placeholder = `{{${nextNum}}}`;

    // Insert at cursor
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newBody = formBody.slice(0, start) + placeholder + formBody.slice(end);
    setFormBody(newBody);

    // Pre-fill sample value
    if (field.sample) {
      setFormVariableSamples(prev => ({ ...prev, [placeholder]: field.sample }));
    }

    setShowVarPicker(false);

    // Restore focus and move cursor after inserted text
    setTimeout(() => {
      textarea.focus();
      const pos = start + placeholder.length;
      textarea.setSelectionRange(pos, pos);
    }, 0);
  }

  // Detect variables in body text — sorted unique list e.g. ['{{1}}', '{{2}}']
  const detectedVariables = [...new Set(formBody.match(/\{\{(\d+)\}\}/g) || [])].sort(
    (a, b) => parseInt(a.replace(/\D/g, '')) - parseInt(b.replace(/\D/g, ''))
  );

  // Render body for preview — replace {{N}} with sample if available, highlight if not
  function renderPreviewBody(body: string) {
    if (!body) return null;
    const parts = body.split(/(\{\{\d+\}\})/g);
    return parts.map((part, i) => {
      const match = part.match(/^\{\{(\d+)\}\}$/);
      if (match) {
        const sample = formVariableSamples[part];
        if (sample) return <span key={i} className="font-semibold text-green-700">{sample}</span>;
        return <span key={i} className="rounded bg-orange-100 px-0.5 font-mono text-xs text-orange-600">{part}</span>;
      }
      return <span key={i}>{part}</span>;
    });
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{c.title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {c.subtitle}
          </p>
        </div>
        <button
          onClick={() => {
            if (showForm) { setShowForm(false); resetForm(); }
            else { setShowForm(true); setEditingTemplateId(null); }
            setError(null);
            setSuccess(null);
          }}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          {showForm ? c.cancel : c.newTemplate}
        </button>
      </div>

      {/* Status messages */}
      {error && (
        <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 rounded-lg bg-green-500/10 border border-green-500/20 px-4 py-3 text-sm text-green-300">
          {success}
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="mb-8">
          <div className="flex gap-6 items-start">

            {/* Left — form fields */}
            <div className="flex-1 rounded-xl border border-slate-300 bg-slate-50 p-6">
              <h2 className="mb-1 text-lg font-semibold text-slate-900">
                {editingTemplateId ? c.editTemplate : c.createTemplate}
              </h2>
              <p className="mb-5 text-sm text-slate-500">{c.formIntro}</p>
              {editingTemplateId && (
                <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300">
                  {c.editWarning}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">{c.templateName}</label>
                  <input
                    type="text"
                    value={formName}
                    onChange={e => setFormName(e.target.value)}
                    placeholder={c.templateNamePlaceholder}
                    disabled={!!editingTemplateId}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    required
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    {editingTemplateId ? c.nameNoChange : c.nameRules}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">{c.category}</label>
                  <select
                    value={formCategory}
                    onChange={e => setFormCategory(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
                  >
                    {CATEGORIES.map(cat => (
                      <option key={cat.value} value={cat.value}>{c.categoryLabels[cat.value]} — {c.categoryDescs[cat.value]}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-600 mb-1">{c.header} <span className="text-slate-500 font-normal">{c.optional}</span></label>
                <input
                  type="text"
                  value={formHeader}
                  onChange={e => setFormHeader(e.target.value)}
                  placeholder={c.headerPlaceholder}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none"
                />
                {/\{\{1\}\}/.test(formHeader) && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="shrink-0 rounded-md border border-slate-300 bg-slate-100 px-2.5 py-1.5 font-mono text-xs text-blue-300">{'{{1}}'}</span>

                    {/* Header tag picker */}
                    <div className="relative shrink-0" ref={headerTagPickerRef}>
                      {formHeaderLabel ? (
                        <span className="flex items-center gap-1 rounded-full bg-blue-500/20 border border-blue-500/40 pl-2.5 pr-1.5 py-1 text-xs font-medium text-blue-300">
                          <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M17.707 9.293l-7-7A1 1 0 0010 2H4a2 2 0 00-2 2v6a1 1 0 00.293.707l7 7a1 1 0 001.414 0l7-7a1 1 0 000-1.414z" clipRule="evenodd" />
                          </svg>
                          {displayLabel(formHeaderLabel)}
                          <button
                            type="button"
                            onClick={() => { setFormHeaderLabel(''); setFormHeaderSample(''); }}
                            className="ml-0.5 rounded-full p-0.5 hover:bg-blue-400/30 transition-colors"
                          >
                            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowHeaderTagPicker(v => !v)}
                          className="flex items-center gap-1.5 rounded-full border border-dashed border-slate-500 bg-slate-100 px-2.5 py-1 text-xs text-slate-500 hover:border-blue-400 hover:text-blue-300 transition-colors whitespace-nowrap"
                        >
                          <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M17.707 9.293l-7-7A1 1 0 0010 2H4a2 2 0 00-2 2v6a1 1 0 00.293.707l7 7a1 1 0 001.414 0l7-7a1 1 0 000-1.414z" clipRule="evenodd" />
                          </svg>
                          {c.selectCustomVariable}
                        </button>
                      )}

                      {showHeaderTagPicker && (
                        <div className="absolute left-0 top-full z-30 mt-1 w-52 rounded-lg border border-slate-300 bg-slate-100 shadow-xl">
                          <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{c.assignVariable}</p>
                          {VARIABLE_FIELDS.map(field => (
                            <button
                              key={field.label}
                              type="button"
                              onClick={() => {
                                setFormHeaderLabel(field.label);
                                if (field.sample) setFormHeaderSample(field.sample);
                                setShowHeaderTagPicker(false);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-700 transition-colors"
                            >
                              <svg className="h-3 w-3 shrink-0 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M17.707 9.293l-7-7A1 1 0 0010 2H4a2 2 0 00-2 2v6a1 1 0 00.293.707l7 7a1 1 0 001.414 0l7-7a1 1 0 000-1.414z" clipRule="evenodd" />
                              </svg>
                              <span className="flex-1">{displayLabel(field.label)}</span>
                              {field.sample && <span className="text-xs text-slate-500">{field.sample}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <input
                      type="text"
                      value={formHeaderSample}
                      onChange={e => setFormHeaderSample(e.target.value)}
                      placeholder={formHeaderLabel ? `${c.eg} ${VARIABLE_FIELDS.find(f => f.label === formHeaderLabel)?.sample || (lang === 'fr' ? 'valeur d’exemple' : 'sample value')}` : (lang === 'fr' ? 'ex. Rappel contrôle technique' : 'e.g. MOT Reminder')}
                      className="flex-1 rounded-lg border border-slate-300 bg-slate-100 px-3 py-1.5 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-400 focus:outline-none"
                    />
                  </div>
                )}
              </div>

              <div className="mb-4">
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-600">
                    {c.body} <span className="text-red-400">*</span>
                  </label>
                  <div className="relative" ref={varPickerRef}>
                    <button
                      type="button"
                      onClick={() => setShowVarPicker(v => !v)}
                      className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-slate-100 px-2.5 py-1 text-xs font-medium text-blue-300 hover:bg-slate-700 hover:text-blue-200 transition-colors"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                      </svg>
                      {c.insertVariable}
                    </button>
                    {showVarPicker && (
                      <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-slate-300 bg-slate-100 shadow-xl">
                        <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{c.selectField}</p>
                        {VARIABLE_FIELDS.map(field => (
                          <button
                            key={field.label}
                            type="button"
                            onClick={() => insertVariable(field)}
                            className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-700 transition-colors"
                          >
                            {displayLabel(field.label)}
                            {field.sample && (
                              <span className="ml-2 text-xs text-slate-500">{c.eg} {field.sample}</span>
                            )}
                          </button>
                        ))}
                        <div className="border-t border-slate-300 p-1">
                          <button
                            type="button"
                            onClick={() => setShowVarPicker(false)}
                            className="block w-full rounded px-2 py-1 text-xs text-slate-500 hover:text-slate-600 transition-colors text-center"
                          >
                            {c.cancel}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <textarea
                  ref={bodyRef}
                  value={formBody}
                  onChange={e => setFormBody(e.target.value)}
                  placeholder={lang === 'fr' ? 'Saisissez le corps du modèle ici' : 'Enter template body here'}
                  rows={4}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none"
                  required
                />
                <p className="mt-1 text-xs text-slate-500">
                  {c.useVars()}
                  {detectedVariables.length > 0 && (
                    <span className="ml-2 text-blue-400">{c.varsDetected(detectedVariables.length)}</span>
                  )}
                </p>

                {/* Variable sample inputs with tag picker */}
                {detectedVariables.length > 0 && (
                  <div className="mt-3 rounded-lg border border-slate-300 bg-white p-3 space-y-2">
                    <p className="text-xs font-medium text-slate-500">
                      {c.sampleValues} <span className="text-slate-500 font-normal">{c.requiredForMeta}</span>
                    </p>
                    {detectedVariables.map(variable => {
                      const assignedLabel = formVariableLabels[variable];
                      return (
                        <div key={variable} className="flex items-center gap-2">
                          {/* Variable badge */}
                          <span className="shrink-0 rounded-md border border-slate-300 bg-slate-100 px-2.5 py-1.5 font-mono text-xs text-blue-300">
                            {variable}
                          </span>

                          {/* Tag picker */}
                          <div
                            className="relative shrink-0"
                            ref={el => { tagPickerRefs.current[variable] = el; }}
                          >
                            {assignedLabel ? (
                              <span className="flex items-center gap-1 rounded-full bg-blue-500/20 border border-blue-500/40 pl-2.5 pr-1.5 py-1 text-xs font-medium text-blue-300">
                                <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M17.707 9.293l-7-7A1 1 0 0010 2H4a2 2 0 00-2 2v6a1 1 0 00.293.707l7 7a1 1 0 001.414 0l7-7a1 1 0 000-1.414z" clipRule="evenodd" />
                                </svg>
                                {displayLabel(assignedLabel)}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setFormVariableLabels(prev => { const n = { ...prev }; delete n[variable]; return n; });
                                    setFormVariableSamples(prev => ({ ...prev, [variable]: '' }));
                                  }}
                                  className="ml-0.5 rounded-full p-0.5 hover:bg-blue-400/30 transition-colors"
                                >
                                  <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setShowTagPicker(showTagPicker === variable ? null : variable)}
                                className="flex items-center gap-1.5 rounded-full border border-dashed border-slate-500 bg-slate-100 px-2.5 py-1 text-xs text-slate-500 hover:border-blue-400 hover:text-blue-300 transition-colors whitespace-nowrap"
                              >
                                <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M17.707 9.293l-7-7A1 1 0 0010 2H4a2 2 0 00-2 2v6a1 1 0 00.293.707l7 7a1 1 0 001.414 0l7-7a1 1 0 000-1.414z" clipRule="evenodd" />
                                </svg>
                                {c.selectCustomVariable}
                              </button>
                            )}

                            {showTagPicker === variable && (
                              <div className="absolute left-0 top-full z-30 mt-1 w-52 rounded-lg border border-slate-300 bg-slate-100 shadow-xl">
                                <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{c.assignVariable}</p>
                                {VARIABLE_FIELDS.map(field => (
                                  <button
                                    key={field.label}
                                    type="button"
                                    onClick={() => {
                                      setFormVariableLabels(prev => ({ ...prev, [variable]: field.label }));
                                      setFormVariableSamples(prev => ({
                                        ...prev,
                                        ...(field.sample ? { [variable]: field.sample } : {}),
                                        [`${variable}_field`]: field.field,
                                      }));
                                      setShowTagPicker(null);
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-700 transition-colors"
                                  >
                                    <svg className="h-3 w-3 shrink-0 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                                      <path fillRule="evenodd" d="M17.707 9.293l-7-7A1 1 0 0010 2H4a2 2 0 00-2 2v6a1 1 0 00.293.707l7 7a1 1 0 001.414 0l7-7a1 1 0 000-1.414z" clipRule="evenodd" />
                                    </svg>
                                    <span className="flex-1">{displayLabel(field.label)}</span>
                                    {field.sample && <span className="text-xs text-slate-500">{field.sample}</span>}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Sample value text input */}
                          <input
                            type="text"
                            value={formVariableSamples[variable] || ''}
                            onChange={e => setFormVariableSamples(prev => ({ ...prev, [variable]: e.target.value }))}
                            placeholder={assignedLabel ? `${c.eg} ${VARIABLE_FIELDS.find(f => f.label === assignedLabel)?.sample || (lang === 'fr' ? 'valeur d’exemple' : 'sample value')}` : c.enterSampleValue}
                            className="flex-1 rounded-lg border border-slate-300 bg-slate-100 px-3 py-1.5 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-400 focus:outline-none"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-600 mb-1">{c.footer} <span className="text-slate-500 font-normal">{c.optional}</span></label>
                <input
                  type="text"
                  value={formFooter}
                  onChange={e => setFormFooter(e.target.value)}
                  placeholder={c.footerPlaceholder}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-slate-600 mb-1">{c.button} <span className="text-slate-500 font-normal">{c.optional}</span></label>
                <div className="grid grid-cols-3 gap-3">
                  <select
                    value={formButtonType}
                    onChange={e => setFormButtonType(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="none">{c.noButton}</option>
                    <option value="url">{c.urlButton}</option>
                    <option value="call">{c.callButton}</option>
                  </select>
                  {formButtonType !== 'none' && (
                    <>
                      <input
                        type="text"
                        value={formButtonText}
                        onChange={e => setFormButtonText(e.target.value)}
                        placeholder={c.buttonLabel}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none"
                      />
                      <input
                        type="text"
                        value={formButtonValue}
                        onChange={e => setFormButtonValue(e.target.value)}
                        placeholder={formButtonType === 'url' ? 'https://...' : '+44...'}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none"
                      />
                    </>
                  )}
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
              >
                {submitting
                  ? (editingTemplateId ? c.saving : c.creating)
                  : (editingTemplateId ? c.saveChanges : c.createTemplate)}
              </button>
            </div>

            {/* Right — WhatsApp preview */}
            <div className="w-80 shrink-0">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{c.preview}</p>
              {/* Phone frame */}
              <div className="rounded-2xl border border-slate-300 overflow-hidden shadow-xl">
                {/* WhatsApp header bar */}
                <div className="bg-[#075e54] px-4 py-3 flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-slate-400/40 flex items-center justify-center">
                    <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{c.businessName}</p>
                    <p className="text-xs text-green-200">{c.whatsappBusiness}</p>
                  </div>
                </div>
                {/* Chat background */}
                <div className="bg-[#e5ddd5] min-h-[320px] p-3 relative">
                  <div
                    className="absolute inset-0 opacity-10"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='0.4'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")` }}
                  />
                  {/* Message bubble */}
                  <div className="relative max-w-[85%] ml-auto">
                    <div className="rounded-tl-lg rounded-bl-lg rounded-br-lg bg-white shadow-sm">
                      <div className="p-3">
                        {formHeader && (
                          <p className="font-semibold text-gray-900 text-sm mb-1">
                            {/\{\{1\}\}/.test(formHeader)
                              ? formHeader.replace('{{1}}', formHeaderSample || '{{1}}')
                              : formHeader}
                          </p>
                        )}
                        <p className="text-sm leading-relaxed text-gray-800 whitespace-pre-wrap">
                          {formBody ? renderPreviewBody(formBody) : <span className="text-gray-400 italic">{c.messageAppears}</span>}
                        </p>
                        {formFooter && (
                          <p className="mt-2 text-xs leading-5 text-gray-500">{formFooter}</p>
                        )}
                        <p className="mt-1 text-right text-[10px] text-gray-400">12:00 ✓✓</p>
                      </div>
                      {formButtonType !== 'none' && formButtonText && (
                        <div className="border-t border-gray-100 py-2 px-3 text-center bg-white rounded-b-lg">
                          <span className="text-sm text-[#0a84ff] font-medium">{formButtonText}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </form>
      )}

      {/* Template list */}
      {templates.length === 0 && !showForm ? (
        <div className="rounded-xl border border-slate-300 bg-slate-50 p-12 text-center">
          <p className="text-slate-500">{c.noTemplates}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map(t => (
            <div key={t.id} className="rounded-xl border border-slate-300 bg-slate-50 p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-3">
                    <h3 className="font-medium text-slate-900">{t.name}</h3>
                    <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_COLORS[t.status] || STATUS_COLORS.draft)}>
                      {c.statusLabels[t.status] ?? t.status}
                    </span>
                    <span className="rounded-full bg-slate-700/50 px-2.5 py-0.5 text-xs text-slate-500">
                      {c.categoryLabels[t.category] ?? t.category}
                    </span>
                  </div>
                  {t.rejectionReason && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
                      <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                      <div>
                        <p className="text-xs font-medium text-red-300">{c.rejectedByMeta}</p>
                        <p className="mt-0.5 text-xs text-red-400/80">{t.rejectionReason}</p>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {t.status === 'draft' && (
                    <button
                      onClick={() => handleSubmitToMeta(t.id)}
                      disabled={syncing === t.id}
                      className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
                    >
                      {syncing === t.id ? c.submitting : c.submitToWhatsapp}
                    </button>
                  )}
                  {t.status === 'pending' && (
                    <button
                      onClick={() => handleSync(t.id)}
                      disabled={syncing === t.id}
                      className="rounded-lg bg-yellow-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-500 disabled:opacity-50 transition-colors"
                    >
                      {syncing === t.id ? c.checking : c.checkStatus}
                    </button>
                  )}
                  {t.status === 'rejected' && (
                    <button
                      onClick={() => handleSubmitToMeta(t.id)}
                      disabled={syncing === t.id}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                    >
                      {syncing === t.id ? c.resubmitting : c.resubmit}
                    </button>
                  )}
                  <button
                    onClick={() => handleEdit(t)}
                    className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-600 transition-colors"
                  >
                    {c.edit}
                  </button>
                  <button
                    onClick={() => handleDelete(t.id)}
                    className="rounded-lg bg-red-600/20 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-600/40 transition-colors"
                  >
                    {c.del}
                  </button>
                </div>
              </div>

              {/* Template body preview */}
              <div className="rounded-lg bg-white p-3">
                {t.headerContent && <p className="font-semibold text-slate-600 text-sm mb-1">{t.headerContent}</p>}
                <p className="text-sm text-slate-500 whitespace-pre-wrap">{t.bodyText}</p>
                {t.footerText && <p className="mt-1 text-xs text-slate-500">{t.footerText}</p>}
                {t.buttonType && t.buttonText && (
                  <div className="mt-2 border-t border-slate-300 pt-2 text-center">
                    <span className="text-xs text-blue-400">{t.buttonText}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
