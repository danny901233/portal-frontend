'use client';

import { useRef, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getGarageId, getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';
import {
  createOutboundCampaign,
  fetchOutboundLimits,
  updateOutboundLimit,
  resumeOutboundSending,
  fetchOutboundCampaigns,
  fetchOutboundCampaign,
  fetchGarageTemplates,
  sendOutboundCampaign,
  fetchGarageHiveReminders,
  fetchGarageHiveSettings,
  updateGarageHiveSettings,
} from '../lib/api';
import type { OutboundCampaign, OutboundContact, OutboundContactInput, MessageTemplate } from '../lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLang } from '@/app/i18n/LocaleProvider';
import TemplatesPage from '../templates/page';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-500/20 text-slate-600',
  sending: 'bg-yellow-500/20 text-yellow-300',
  sent: 'bg-green-500/20 text-green-300',
  processed: 'bg-green-500/20 text-green-300',
  failed: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  queued: 'bg-blue-500/20 text-blue-300',
};

const STATUS_LABELS: Record<'en' | 'fr', Record<string, string>> = {
  en: {
    draft: 'Draft',
    sending: 'Sending',
    sent: 'Processed',
    processed: 'Processed',
    failed: 'Failed',
    queued: 'Queued',
  },
  fr: {
    draft: 'Brouillon',
    sending: 'Envoi en cours',
    sent: 'Traité',
    processed: 'Traité',
    failed: 'Échec',
    queued: 'En file',
  },
};

const REQUIRED_COLS = ['customer_name', 'phone'];

function parseCSV(text: string, lang: 'en' | 'fr' = 'en'): { rows: OutboundContactInput[]; error?: string } {
  const cc = {
    en: {
      needRows: 'CSV must have a header row and at least one data row.',
      missingCol: (col: string) => `Missing required column: "${col}"`,
      precisionLost: (i: number, raw: string, phone: string) =>
        `Phone number precision lost in row ${i} ("${raw}" → "${phone}"). Excel has rounded this number. Please format the Phone column as Text in Excel before saving as CSV, or use a text editor to create the CSV.`,
      noRows: 'No valid rows found in CSV.',
    },
    fr: {
      needRows: 'Le fichier CSV doit comporter une ligne d’en-tête et au moins une ligne de données.',
      missingCol: (col: string) => `Colonne obligatoire manquante : « ${col} »`,
      precisionLost: (i: number, raw: string, phone: string) =>
        `Précision du numéro de téléphone perdue à la ligne ${i} (« ${raw} » → « ${phone} »). Excel a arrondi ce numéro. Veuillez formater la colonne Téléphone en Texte dans Excel avant d’enregistrer au format CSV, ou utilisez un éditeur de texte pour créer le fichier CSV.`,
      noRows: 'Aucune ligne valide trouvée dans le fichier CSV.',
    },
  }[lang];
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { rows: [], error: cc.needRows };

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));

  for (const col of REQUIRED_COLS) {
    if (!header.includes(col)) {
      return { rows: [], error: cc.missingCol(col) };
    }
  }

  const idx = (col: string) => header.indexOf(col);

  const rows: OutboundContactInput[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle quoted fields
    const cells: string[] = [];
    let current = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { cells.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    cells.push(current.trim());

    const get = (col: string) => (idx(col) >= 0 ? cells[idx(col)]?.trim() || undefined : undefined);

    const customerName = get('customer_name');
    const rawPhone = get('phone');
    if (!customerName || !rawPhone) continue;

    // Fix scientific notation phone numbers exported by Excel (e.g. 4.47911E+11 → +447911...)
    let phone = rawPhone;
    let truncated = false;
    if (/^\d+\.?\d*[eE][+\-]?\d+$/.test(rawPhone)) {
      const expanded = Number(rawPhone).toFixed(0);
      phone = expanded.startsWith('44') ? `+${expanded}` : expanded;
      // Warn if precision was lost — trailing zeros suggest Excel rounded the number
      if (/0{4,}$/.test(expanded)) truncated = true;
    }
    if (truncated) {
      return { rows: [], error: cc.precisionLost(i, rawPhone, phone) };
    }

    rows.push({
      customerName,
      phone,
      registration: get('registration'),
      motDueDate: get('mot_due_date'),
      serviceDueDate: get('service_due_date'),
    });
  }

  if (rows.length === 0) return { rows: [], error: cc.noRows };
  return { rows };
}

export default function OutboundPage() {
  const router = useRouter();
  const garageId = getGarageId() || '';
  const queryClient = useQueryClient();
  const lang = useLang();
  const c = {
    en: {
      settingsSaved: 'Garage Hive reminder settings saved.',
      settingsFailed: 'Failed to save reminder settings.',
      contactsSkipped: (n: number, sendable: number) =>
        `${n} contact${n > 1 ? 's' : ''} skipped — previously opted out. ${sendable} will be messaged.`,
      messagesSending: (n: number) =>
        `Messages are being sent to ${n} contact${n !== 1 ? 's' : ''}!`,
      createdNoSend: 'Campaign created but failed to trigger send. Try the Send button on the campaign.',
      createFailed: 'Failed to create campaign.',
      enterName: 'Please enter a campaign name.',
      selectTemplate: 'Please select an approved WhatsApp template. Plain text messages cannot be delivered outside the 24-hour window.',
      loadResultsFailed: 'Failed to load campaign results.',
      messagesSent: 'Messages sent!',
      sendFailed: 'Failed to send messages.',
      noVehicles: (days: number) => `No vehicles due in ${days} days found in Garage Hive.`,
      ghNotConnected: 'Garage Hive is not connected for this garage yet.',
      ghFetchFailed: 'Failed to fetch reminders from Garage Hive.',
      title: 'Outbound Messaging',
      subtitle: 'Upload a customer list and send personalised MOT or service reminders via SMS or WhatsApp. Customers who reply will be handled automatically by your AI agent.',
      newCampaign: 'New Campaign',
      step1: 'Step 1 — Create your template and submit it',
      step1Body: 'WhatsApp only lets you start a conversation with a template Meta has approved. An MOT and a service reminder are already written for you below — check the wording and submit them. Approval usually comes back within a few hours. SMS needs no approval.',
      step2: 'Step 2 — Create the campaign',
      step2Body: 'Name it, pick the channel, then say whether it\u2019s a reminder series or a one-off. Bring your customers in from a CSV (customer_name, phone, registration, mot_due_date, service_due_date) or straight from Garage Hive. Upload as far ahead as your system will export — nobody is messaged until their own due date is close.',
      step3: 'Step 3 — Check and send',
      step3Body: 'Check the names and numbers look right, then send. Messages go out spaced a few seconds apart rather than all at once, which is what keeps a WhatsApp number in good standing; a large list carries on over following days automatically.',
      haltTitle: 'Outbound messaging is paused',
      haltBody: 'This is a protection. Carrying on after a warning like this is what gets a WhatsApp number permanently disabled — please don\u2019t re-send the same list. Reply to the email we sent and we\u2019ll go through it with you.',
      haltResume: 'Resume sending (staff)',
      haltResumed: 'Sending resumed.',
      allowanceTitle: 'Daily sending allowance',
      allowanceUsed: (sent: number, limit: number) => `${sent} of ${limit} sent in the last 24 hours`,
      allowanceLeft: (left: number) => `${left} left`,
      allowanceNone: 'None left right now — anything you send will be queued.',
      allowanceFrees: (t: string) => `Allowance starts freeing up at ${t}`,
      allowanceFull: (t: string) => `back to the full allowance at ${t}.`,
      allowanceIdle: 'Nothing sent in the last 24 hours.',
      allowanceHelp: 'Messages go out about one every 30 seconds, between 8am and 8pm. The allowance is a rolling 24 hours rather than a midnight reset, and anything over it is queued and sent automatically.',
      allowanceStaffNote: 'The limit is set by ReceptionMate, deliberately below WhatsApp\u2019s own so your number never gets near it.',
      limitEdit: 'Change limit (staff)',
      limitSaved: 'Daily limit updated.',
      limitFailed: 'Could not update the limit.',
      step4: 'Step 4 — See what came back',
      step4Body: 'Every campaign shows what was delivered, who replied, and which replies your agent turned into a booking. Click a campaign to see it customer by customer.',
      howFooter: 'Opt-outs are permanent and shared across every campaign \u2014 once someone says stop, they are never messaged again.',
      campaignName: 'Campaign name',
      campaignNamePlaceholder: 'e.g. March MOT Reminders',
      channel: 'Channel',
      campaignKind: 'Campaign type',
      kindReminder: 'MOT / service reminders',
      kindReminderBody: 'Each customer is messaged before THEIR due date, and chased again if they don\u2019t reply.',
      kindOneoff: 'One-off message',
      kindOneoffBody: 'Sent once. Offers, announcements, opening hours \u2014 anything you would not chase.',
      followUps: 'How many days before the due date should we message?',
      followUpsHelp: 'Pick as many as you like \u2014 each customer gets one message at each point, counted from their own due date. Anyone who replies or books is taken off the rest.',
      followUpsNone: 'Pick at least one send point.',
      stageDays: (d: number) => (d === 1 ? '1 day' : `${d} days`),
      customLabel: 'Custom',
      customPlaceholder: 'e.g. 45',
      customAdd: 'Add',
      customRange: 'Between 1 and 120 days.',
      followUpsSummary: (days: number[]) =>
        days.length === 1
          ? `We\u2019ll message once, ${days[0]} day${days[0] === 1 ? '' : 's'} before each customer\u2019s due date.`
          : `We\u2019ll message ${days.slice(0, -1).join(', ')} and ${days[days.length - 1]} days before each customer\u2019s due date, stopping as soon as they reply.`,
      oneoffNote: 'No follow-ups \u2014 this goes out once.',
      messageTemplate: 'Message template',
      templateOptional: '(optional — uses default reminder if not selected)',
      useDefault: '— Use default reminder message —',
      noApprovedTemplates: 'No approved templates yet.',
      createApprove: 'Create and approve one',
      toUseCustom: 'to use custom messages.',
      mapVariables: 'Map template variables to CSV columns:',
      selectColumn: '— select column —',
      contactSource: 'Contact source',
      csvUpload: 'CSV upload',
      ghNotConnectedTitle: 'Garage Hive isn’t connected for this garage yet.',
      ghNotConnectedBody: 'Once the Garage Hive connection is set up, you can turn on automatic daily reminders here.',
      autoReminders: 'Automatic daily reminders',
      autoRemindersBody: 'Every morning at 9am we pull vehicles due in Garage Hive and message the customer automatically. Delivery, read and reply status is tracked for each one.',
      remindWithin: 'Remind when due within (days)',
      whatsappTemplate: 'WhatsApp template',
      selectApproved: 'Select an approved template…',
      saving: 'Saving…',
      save: 'Save',
      noApprovedWhatsapp: 'No approved WhatsApp templates yet — you’ll need one before reminders can be sent automatically.',
      autoOn: 'Automatic reminders are ON — runs daily at 9am.',
      autoOff: 'Automatic reminders are off.',
      lastRun: (d: string) => ` Last run: ${d}.`,
      lastError: (e: string) => ` Last error: ${e}`,
      oneOffLead: 'Or send a one-off now.',
      oneOffBody: 'Pull customers whose MOT or service falls due in Garage Hive. Vehicles marked “disable reminders” are automatically excluded.',
      dueWithin: 'Due within (days)',
      fetching: 'Fetching…',
      pullFromGh: 'Pull from Garage Hive',
      vehiclesSkipped: (n: number) => `${n} vehicle${n > 1 ? 's' : ''} skipped (no contact number or unlinked customer).`,
      customerCsv: 'Customer CSV',
      csvColumns: '(columns: customer_name, phone, registration, mot_due_date, service_due_date)',
      downloadSample: 'Download sample CSV',
      contactsPreview: (n: number, fromGh: boolean) =>
        `${n} contact${n !== 1 ? 's' : ''} ${fromGh ? 'from Garage Hive' : 'imported'} — preview:`,
      colName: 'Name',
      colPhone: 'Phone',
      colReg: 'Reg',
      colMotDue: 'MOT Due',
      colServiceDue: 'Service Due',
      andMore: (n: number) => `…and ${n} more`,
      sending: 'Sending…',
      sendReminders: (n: number) => `Send ${n} Reminders`,
      cancel: 'Cancel',
      pastCampaigns: 'Past Campaigns',
      loadingCampaigns: 'Loading campaigns…',
      noCampaigns: 'No campaigns yet. Upload a CSV above to get started.',
      thName: 'Name',
      thChannel: 'Channel',
      thContacts: 'Contacts',
      thSentRate: 'Sent Rate',
      thStatus: 'Status',
      thDate: 'Date',
      loadingModal: 'Loading…',
      sentTotal: (sent: number, total: number, date: string) => `${sent} sent · ${total} total · ${date}`,
      statSent: 'Sent',
      statDelivered: 'Delivered',
      statRead: 'Read',
      statReplied: 'Replied',
      statFailed: 'Failed',
      statBooked: 'Booked',
      thReplies: 'Replies',
      thBooked: 'Booked',
      cOutcome: 'Outcome',
      outcomeBooked: 'Booked',
      outcomeReplied: 'Replied',
      outcomeAwaiting: 'Awaiting reply',
      openConversation: 'Open conversation',
      loadingContacts: 'Loading contacts…',
      noContacts: 'No contacts found.',
      cDetail: 'Detail',
      statusLabels: {
        pending: 'Pending',
        sent: 'Sent (unconfirmed)',
        delivered: 'Delivered',
        read: 'Read',
        replied: 'Replied',
        booked: 'Booked',
        failed: 'Failed',
        expired: 'Due date passed',
        opted_out: 'Opted Out',
      } as Record<string, string>,
    },
    fr: {
      settingsSaved: 'Paramètres de rappels Garage Hive enregistrés.',
      settingsFailed: 'Échec de l’enregistrement des paramètres de rappels.',
      contactsSkipped: (n: number, sendable: number) =>
        `${n} contact${n > 1 ? 's' : ''} ignoré${n > 1 ? 's' : ''} — désabonnement antérieur. ${sendable} recevront un message.`,
      messagesSending: (n: number) =>
        `Les messages sont en cours d’envoi à ${n} contact${n !== 1 ? 's' : ''} !`,
      createdNoSend: 'Campagne créée mais l’envoi n’a pas pu être déclenché. Essayez le bouton Envoyer sur la campagne.',
      createFailed: 'Échec de la création de la campagne.',
      enterName: 'Veuillez saisir un nom de campagne.',
      selectTemplate: 'Veuillez sélectionner un modèle WhatsApp approuvé. Les messages en texte brut ne peuvent pas être livrés en dehors de la fenêtre de 24 heures.',
      loadResultsFailed: 'Échec du chargement des résultats de la campagne.',
      messagesSent: 'Messages envoyés !',
      sendFailed: 'Échec de l’envoi des messages.',
      noVehicles: (days: number) => `Aucun véhicule à échéance dans ${days} jours trouvé dans Garage Hive.`,
      ghNotConnected: 'Garage Hive n’est pas encore connecté pour ce garage.',
      ghFetchFailed: 'Échec de la récupération des rappels depuis Garage Hive.',
      title: 'Messagerie sortante',
      subtitle: 'Importez une liste de clients et envoyez des rappels personnalisés de contrôle technique ou d’entretien par SMS ou WhatsApp. Les clients qui répondent sont pris en charge automatiquement par votre agent IA.',
      newCampaign: 'Nouvelle campagne',
      step1: 'Étape 1 — Créez votre modèle et soumettez-le',
      step1Body: 'WhatsApp n\u2019autorise l\u2019ouverture d\u2019une conversation qu\u2019avec un modèle approuvé par Meta. Un modèle contrôle technique et un modèle entretien sont déjà rédigés ci-dessous — vérifiez le texte et soumettez-les. L\u2019approbation arrive généralement en quelques heures. Le SMS ne demande aucune approbation.',
      step2: 'Étape 2 — Créez la campagne',
      step2Body: 'Nommez-la, choisissez le canal, puis indiquez s\u2019il s\u2019agit d\u2019une série de rappels ou d\u2019un envoi unique. Importez vos clients depuis un CSV (customer_name, phone, registration, mot_due_date, service_due_date) ou directement depuis Garage Hive. Importez aussi loin que votre système l\u2019autorise — personne n\u2019est contacté avant que sa propre échéance approche.',
      step3: 'Étape 3 — Vérifiez et envoyez',
      step3Body: 'Vérifiez que les noms et les numéros sont corrects, puis envoyez. Les messages partent espacés de quelques secondes plutôt que tous en même temps, ce qui protège la réputation de votre numéro WhatsApp ; une longue liste se poursuit automatiquement les jours suivants.',
      haltTitle: 'La messagerie sortante est en pause',
      haltBody: 'Il s\u2019agit d\u2019une protection. Continuer après un tel avertissement est ce qui fait désactiver définitivement un numéro WhatsApp — merci de ne pas renvoyer la même liste. Répondez à l\u2019e-mail que nous vous avons envoyé et nous verrons cela avec vous.',
      haltResume: 'Reprendre l\u2019envoi (personnel)',
      haltResumed: 'Envoi repris.',
      allowanceTitle: 'Allocation d\u2019envoi quotidienne',
      allowanceUsed: (sent: number, limit: number) => `${sent} sur ${limit} envoyés ces dernières 24 heures`,
      allowanceLeft: (left: number) => `${left} restants`,
      allowanceNone: 'Plus rien de disponible — tout envoi sera mis en file.',
      allowanceFrees: (t: string) => `L\u2019allocation commence à se libérer à ${t}`,
      allowanceFull: (t: string) => `allocation complète rétablie à ${t}.`,
      allowanceIdle: 'Aucun envoi ces dernières 24 heures.',
      allowanceHelp: 'Les messages partent environ un toutes les 30 secondes, entre 8h et 20h. L\u2019allocation porte sur 24 heures glissantes et non sur une remise à zéro à minuit ; tout dépassement est mis en file et envoyé automatiquement.',
      allowanceStaffNote: 'La limite est fixée par ReceptionMate, volontairement sous celle de WhatsApp pour que votre numéro n\u2019en approche jamais.',
      limitEdit: 'Modifier la limite (personnel)',
      limitSaved: 'Limite quotidienne mise à jour.',
      limitFailed: 'Impossible de mettre à jour la limite.',
      step4: 'Étape 4 — Voyez ce qui revient',
      step4Body: 'Chaque campagne indique ce qui a été délivré, qui a répondu, et quelles réponses votre agent a transformées en rendez-vous. Cliquez sur une campagne pour la voir client par client.',
      howFooter: 'Les désabonnements sont définitifs et partagés entre toutes les campagnes \u2014 une fois qu\u2019une personne dit stop, elle n\u2019est plus jamais contactée.',
      campaignName: 'Nom de la campagne',
      campaignNamePlaceholder: 'ex. Rappels contrôle technique de mars',
      channel: 'Canal',
      campaignKind: 'Type de campagne',
      kindReminder: 'Rappels contrôle technique / entretien',
      kindReminderBody: 'Chaque client est contacté avant SA date d\u2019échéance, puis relancé s\u2019il ne répond pas.',
      kindOneoff: 'Message ponctuel',
      kindOneoffBody: 'Envoyé une seule fois. Offres, annonces, horaires \u2014 tout ce que vous ne relanceriez pas.',
      followUps: 'Combien de jours avant l\u2019échéance faut-il envoyer le message ?',
      followUpsHelp: 'Choisissez-en autant que vous voulez \u2014 chaque client reçoit un message à chaque point, compté depuis sa propre échéance. Toute personne qui répond ou réserve est retirée des relances suivantes.',
      followUpsNone: 'Choisissez au moins un point d\u2019envoi.',
      stageDays: (d: number) => (d === 1 ? '1 jour' : `${d} jours`),
      customLabel: 'Personnalisé',
      customPlaceholder: 'ex. 45',
      customAdd: 'Ajouter',
      customRange: 'Entre 1 et 120 jours.',
      followUpsSummary: (days: number[]) =>
        days.length === 1
          ? `Nous enverrons un message ${days[0]} jour${days[0] === 1 ? '' : 's'} avant l\u2019échéance de chaque client.`
          : `Nous enverrons un message ${days.slice(0, -1).join(', ')} et ${days[days.length - 1]} jours avant l\u2019échéance de chaque client, en nous arrêtant dès qu\u2019il répond.`,
      oneoffNote: 'Aucune relance \u2014 envoi unique.',
      messageTemplate: 'Modèle de message',
      templateOptional: '(facultatif — utilise le rappel par défaut si non sélectionné)',
      useDefault: '— Utiliser le message de rappel par défaut —',
      noApprovedTemplates: 'Aucun modèle approuvé pour l’instant.',
      createApprove: 'Créez-en un et faites-le approuver',
      toUseCustom: 'pour utiliser des messages personnalisés.',
      mapVariables: 'Associez les variables du modèle aux colonnes du CSV :',
      selectColumn: '— sélectionner une colonne —',
      contactSource: 'Source des contacts',
      csvUpload: 'Import CSV',
      ghNotConnectedTitle: 'Garage Hive n’est pas encore connecté pour ce garage.',
      ghNotConnectedBody: 'Une fois la connexion Garage Hive configurée, vous pourrez activer les rappels quotidiens automatiques ici.',
      autoReminders: 'Rappels quotidiens automatiques',
      autoRemindersBody: 'Chaque matin à 9 h, nous récupérons les véhicules à échéance dans Garage Hive et envoyons automatiquement un message au client. Le statut de livraison, de lecture et de réponse est suivi pour chacun.',
      remindWithin: 'Rappeler si l’échéance est dans (jours)',
      whatsappTemplate: 'Modèle WhatsApp',
      selectApproved: 'Sélectionnez un modèle approuvé…',
      saving: 'Enregistrement…',
      save: 'Enregistrer',
      noApprovedWhatsapp: 'Aucun modèle WhatsApp approuvé pour l’instant — il vous en faut un avant que les rappels puissent être envoyés automatiquement.',
      autoOn: 'Les rappels automatiques sont ACTIVÉS — exécutés chaque jour à 9 h.',
      autoOff: 'Les rappels automatiques sont désactivés.',
      lastRun: (d: string) => ` Dernière exécution : ${d}.`,
      lastError: (e: string) => ` Dernière erreur : ${e}`,
      oneOffLead: 'Ou envoyez un message ponctuel maintenant.',
      oneOffBody: 'Récupérez les clients dont le contrôle technique ou l’entretien arrive à échéance dans Garage Hive. Les véhicules marqués « désactiver les rappels » sont automatiquement exclus.',
      dueWithin: 'Échéance dans (jours)',
      fetching: 'Récupération…',
      pullFromGh: 'Récupérer depuis Garage Hive',
      vehiclesSkipped: (n: number) => `${n} véhicule${n > 1 ? 's' : ''} ignoré${n > 1 ? 's' : ''} (aucun numéro de contact ou client non lié).`,
      customerCsv: 'CSV client',
      csvColumns: '(colonnes : customer_name, phone, registration, mot_due_date, service_due_date)',
      downloadSample: 'Télécharger un exemple de CSV',
      contactsPreview: (n: number, fromGh: boolean) =>
        `${n} contact${n !== 1 ? 's' : ''} ${fromGh ? 'depuis Garage Hive' : 'importé' + (n !== 1 ? 's' : '')} — aperçu :`,
      colName: 'Nom',
      colPhone: 'Téléphone',
      colReg: 'Immat.',
      colMotDue: 'Contrôle technique dû',
      colServiceDue: 'Entretien dû',
      andMore: (n: number) => `…et ${n} de plus`,
      sending: 'Envoi…',
      sendReminders: (n: number) => `Envoyer ${n} rappels`,
      cancel: 'Annuler',
      pastCampaigns: 'Campagnes passées',
      loadingCampaigns: 'Chargement des campagnes…',
      noCampaigns: 'Aucune campagne pour l’instant. Importez un CSV ci-dessus pour commencer.',
      thName: 'Nom',
      thChannel: 'Canal',
      thContacts: 'Contacts',
      thSentRate: 'Taux d’envoi',
      thStatus: 'Statut',
      thDate: 'Date',
      loadingModal: 'Chargement…',
      sentTotal: (sent: number, total: number, date: string) => `${sent} envoyés · ${total} au total · ${date}`,
      statSent: 'Envoyés',
      statDelivered: 'Livrés',
      statRead: 'Lus',
      statReplied: 'Répondus',
      statFailed: 'Échoués',
      statBooked: 'Réservés',
      thReplies: 'Réponses',
      thBooked: 'Réservés',
      cOutcome: 'Résultat',
      outcomeBooked: 'Réservé',
      outcomeReplied: 'A répondu',
      outcomeAwaiting: 'En attente de réponse',
      openConversation: 'Ouvrir la conversation',
      loadingContacts: 'Chargement des contacts…',
      noContacts: 'Aucun contact trouvé.',
      cDetail: 'Détail',
      statusLabels: {
        pending: 'En attente',
        sent: 'Envoyé (non confirmé)',
        delivered: 'Livré',
        read: 'Lu',
        replied: 'Répondu',
        booked: 'Réservé',
        failed: 'Échec',
        expired: 'Échéance passée',
        opted_out: 'Désabonné',
      } as Record<string, string>,
    },
  }[lang];

  useEffect(() => {
    if (!garageId) return;
    const token = getSessionToken();
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/garages/${garageId}/messaging-access`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then((data: { hasMessagingAccess?: boolean }) => {
        if (!data.hasMessagingAccess) router.replace('/dashboard');
      })
      .catch(() => router.replace('/dashboard'));
  }, [garageId, router]);
  const fileRef = useRef<HTMLInputElement>(null);

  const [campaignName, setCampaignName] = useState('');
  const [channel, setChannel] = useState<'sms' | 'whatsapp'>('whatsapp');
  // Reminders are chased; one-offs are not. Defaulting to 'reminder' matches what almost every
  // garage uploads, but an offer campaign must be switched over or the customer gets it 3 times.
  const [campaignType, setCampaignType] = useState<'reminder' | 'oneoff'>('reminder');
  const [reminderStages, setReminderStages] = useState<number[]>([30, 14, 3]);
  const [customStage, setCustomStage] = useState('');
  const [source, setSource] = useState<'csv' | 'garagehive'>('csv');
  const [ghDays, setGhDays] = useState(30);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghSkipped, setGhSkipped] = useState<{ reg: string; reason: string }[]>([]);
  // Automatic daily reminder settings (mirrors GarageHiveConnection)
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoDays, setAutoDays] = useState(30);
  const [autoTemplateId, setAutoTemplateId] = useState('');
  const [preview, setPreview] = useState<OutboundContactInput[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null); // used for new campaign send only
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [variableMapping, setVariableMapping] = useState<Record<string, string>>({});
  const [selectedCampaign, setSelectedCampaign] = useState<OutboundCampaign | null>(null);
  const [loadingContacts, setLoadingContacts] = useState(false);

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const { data, isLoading } = useQuery({
    queryKey: ['outbound-campaigns', garageId],
    queryFn: () => fetchOutboundCampaigns(garageId),
    enabled: !!garageId,
  });

  const { data: templatesData } = useQuery({
    queryKey: ['templates', garageId],
    queryFn: () => fetchGarageTemplates(garageId),
    enabled: !!garageId && (channel === 'whatsapp' || source === 'garagehive'),
  });

  // Automatic daily reminder settings (Garage Hive connection)
  const { data: limits } = useQuery({
    queryKey: ['outbound-limits', garageId],
    queryFn: () => fetchOutboundLimits(garageId),
    enabled: !!garageId,
  });

  const { data: ghSettings } = useQuery({
    queryKey: ['gh-settings', garageId],
    queryFn: () => fetchGarageHiveSettings(garageId),
    enabled: !!garageId && source === 'garagehive',
  });

  useEffect(() => {
    if (!ghSettings?.connected) return;
    setAutoEnabled(!!ghSettings.remindersEnabled);
    setAutoDays(ghSettings.reminderDaysAhead ?? 30);
    setAutoTemplateId(ghSettings.reminderTemplateId ?? '');
  }, [ghSettings]);

  const saveSettingsMutation = useMutation({
    mutationFn: updateGarageHiveSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gh-settings', garageId] });
      showToast('success', c.settingsSaved);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      showToast('error', msg || c.settingsFailed);
    },
  });

  const approvedTemplates: MessageTemplate[] = (templatesData?.templates || []).filter(
    (t) => t.status === 'approved',
  );

  const selectedTemplate = approvedTemplates.find((t) => t.id === selectedTemplateId) || null;

  // Extract variable numbers from template body e.g. {{1}}, {{2}}
  const templateVariables = selectedTemplate
    ? [...new Set([...selectedTemplate.bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]))]
        .sort((a, b) => Number(a) - Number(b))
    : [];

  // Auto-fill variable mapping from template's saved field assignments
  useEffect(() => {
    if (!selectedTemplate?.variableSamples) {
      setVariableMapping({});
      return;
    }
    const samples = selectedTemplate.variableSamples as Record<string, string>;
    const autoMap: Record<string, string> = {};
    for (const varNum of templateVariables) {
      const fieldKey = `{{${varNum}}}_field`;
      if (samples[fieldKey]) autoMap[varNum] = samples[fieldKey];
    }
    if (Object.keys(autoMap).length > 0) setVariableMapping(autoMap);
  }, [selectedTemplateId]);

  const createMutation = useMutation({
    mutationFn: createOutboundCampaign,
    onSuccess: async ({ campaign }) => {
      queryClient.invalidateQueries({ queryKey: ['outbound-campaigns', garageId] });
      const dncCount = campaign.contacts?.filter((c) => c.status === 'opted_out').length ?? 0;
      const sendable = campaign.totalContacts - dncCount;
      if (dncCount > 0) {
        showToast('error', c.contactsSkipped(dncCount, sendable));
      }
      setSendingId(campaign.id);
      try {
        await sendOutboundCampaign(campaign.id);
        showToast('success', c.messagesSending(sendable));
      } catch {
        showToast('error', c.createdNoSend);
      } finally {
        setSendingId(null);
        queryClient.invalidateQueries({ queryKey: ['outbound-campaigns', garageId] });
        resetForm();
      }
    },
    onError: () => showToast('error', c.createFailed),
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    setPreview(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { rows, error } = parseCSV(text, lang);
      if (error) {
        setParseError(error);
      } else {
        setPreview(rows);
      }
    };
    reader.readAsText(file);
  };

  const handlePullFromGarageHive = async () => {
    setParseError(null);
    setPreview(null);
    setGhSkipped([]);
    setGhLoading(true);
    try {
      const { contacts, skipped } = await fetchGarageHiveReminders(garageId, ghDays);
      setGhSkipped(skipped);
      if (contacts.length === 0) {
        setParseError(c.noVehicles(ghDays));
      } else {
        setPreview(contacts);
      }
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { error?: string; code?: string } } })?.response?.data;
      setParseError(
        data?.code === 'GARAGEHIVE_NOT_CONNECTED'
          ? c.ghNotConnected
          : data?.error || c.ghFetchFailed,
      );
    } finally {
      setGhLoading(false);
    }
  };

  /** Staff-only. A garage cannot raise its own cap — that is the decision that costs it its number. */
  const handleEditLimit = async () => {
    const current = limits?.dailyLimit ?? 240;
    const input = window.prompt(`Daily message limit for this garage (currently ${current}):`, String(current));
    if (input === null) return;
    const n = Number(input);
    if (!Number.isFinite(n) || n < 1 || n > 10000) {
      showToast('error', c.limitFailed);
      return;
    }
    try {
      await updateOutboundLimit(garageId, Math.floor(n));
      showToast('success', c.limitSaved);
      queryClient.invalidateQueries({ queryKey: ['outbound-limits', garageId] });
    } catch {
      showToast('error', c.limitFailed);
    }
  };

  const handleResume = async () => {
    try {
      await resumeOutboundSending(garageId);
      showToast('success', c.haltResumed);
      queryClient.invalidateQueries({ queryKey: ['outbound-limits', garageId] });
    } catch {
      showToast('error', c.limitFailed);
    }
  };

  /** Add a custom days-before value. Out-of-range or duplicate input is ignored, not an error. */
  const addCustomStage = () => {
    const n = Number.parseInt(customStage, 10);
    if (!Number.isFinite(n) || n < 1 || n > 120) {
      showToast('error', c.customRange);
      return;
    }
    setReminderStages((prev) => (prev.includes(n) ? prev : [...prev, n].sort((x, y) => y - x)));
    setCustomStage('');
  };

  const resetForm = () => {
    setCampaignName('');
    setChannel('whatsapp');
    setCampaignType('reminder');
    setReminderStages([30, 14, 3]);
    setCustomStage('');
    setSource('csv');
    setGhDays(30);
    setGhSkipped([]);
    setPreview(null);
    setParseError(null);
    setSelectedTemplateId('');
    setVariableMapping({});
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleImportAndSend = () => {
    if (!preview || preview.length === 0) return;
    if (!campaignName.trim()) {
      showToast('error', c.enterName);
      return;
    }
    if (channel === 'whatsapp' && !selectedTemplateId) {
      showToast('error', c.selectTemplate);
      return;
    }
    if (campaignType === 'reminder' && reminderStages.length === 0) {
      showToast('error', c.followUpsNone);
      return;
    }
    createMutation.mutate({
      garageId,
      name: campaignName.trim(),
      channel,
      campaignType,
      reminderStages: campaignType === 'reminder' ? reminderStages : [],
      contacts: preview,
      ...(selectedTemplateId && { messageTemplateId: selectedTemplateId, variableMapping }),
    });
  };

  const handleViewResults = async (campaign: OutboundCampaign) => {
    setLoadingContacts(true);
    try {
      const { campaign: full } = await fetchOutboundCampaign(campaign.id);
      setSelectedCampaign(full);
    } catch {
      showToast('error', c.loadResultsFailed);
    } finally {
      setLoadingContacts(false);
    }
  };

  const handleResend = async (campaign: OutboundCampaign) => {
    setSendingId(campaign.id);
    try {
      await sendOutboundCampaign(campaign.id);
      showToast('success', c.messagesSent);
      queryClient.invalidateQueries({ queryKey: ['outbound-campaigns', garageId] });
    } catch {
      showToast('error', c.sendFailed);
    } finally {
      setSendingId(null);
    }
  };

  /** Numbered section header. The instruction sits with the controls it describes, rather than
      in one panel at the top that nobody reads twice. */
  const StepHeader = ({ n, title, body }: { n: number; title: string; body: string }) => (
    <div className="mb-4 flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
        {n}
      </span>
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">{body}</p>
      </div>
    </div>
  );

  const campaigns: OutboundCampaign[] = data?.campaigns || [];

  return (
    <div className="space-y-8">
      {/* Templates first: a campaign can only send an APPROVED template, so the thing that blocks
          sending belongs above the thing that sends. Previously these were separate nav items and
          nothing connected them. */}
      {/* Halted: this is the loudest thing on the page for a reason. */}
      {limits?.halt && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-5">
          <h2 className="text-sm font-semibold text-red-900">{c.haltTitle}</h2>
          <p className="mt-2 text-sm text-red-800">{limits.halt.reason}</p>
          <p className="mt-2 text-xs text-red-700">{c.haltBody}</p>
          {limits.canEditLimit && (
            <button
              type="button"
              onClick={handleResume}
              className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
            >
              {c.haltResume}
            </button>
          )}
        </div>
      )}

      {/* Allowance. Always visible, not tucked inside the send step — "how much can I send and
          when does it come back" is a question garages have before they build a campaign. */}
      {limits && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">{c.allowanceTitle}</h2>
            <p className="text-xs text-slate-600">
              <span className="font-medium text-slate-900">{c.allowanceUsed(limits.sentLast24h, limits.dailyLimit)}</span>
              {' · '}
              <span className={cn('font-medium', limits.remaining === 0 ? 'text-amber-700' : 'text-green-700')}>
                {limits.remaining === 0 ? c.allowanceNone : c.allowanceLeft(limits.remaining)}
              </span>
            </p>
          </div>

          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={cn('h-full rounded-full', limits.remaining === 0 ? 'bg-amber-500' : 'bg-blue-600')}
              style={{ width: `${Math.min(100, Math.round((limits.sentLast24h / Math.max(1, limits.dailyLimit)) * 100))}%` }}
            />
          </div>

          <p className="mt-2 text-xs text-slate-500">
            {limits.sentLast24h === 0 || !limits.nextFreeAt ? (
              c.allowanceIdle
            ) : (
              <>
                {c.allowanceFrees(new Date(limits.nextFreeAt).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }))}
                {limits.fullyFreeAt && `, ${c.allowanceFull(new Date(limits.fullyFreeAt).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }))}`}
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {c.allowanceHelp}{' '}
            {c.allowanceStaffNote}
            {limits.canEditLimit && (
              <button
                type="button"
                onClick={handleEditLimit}
                className="ml-2 font-medium text-blue-600 underline hover:text-blue-700"
              >
                {c.limitEdit}
              </button>
            )}
          </p>
        </div>
      )}

      <section id="templates" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <StepHeader n={1} title={c.step1} body={c.step1Body} />
        <TemplatesPage embedded />
      </section>

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-6 right-6 z-50 rounded-lg px-5 py-3 text-sm font-medium shadow-lg',
            toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white',
          )}
        >
          {toast.msg}
        </div>
      )}

      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{c.title}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {c.subtitle}
        </p>
      </div>

      {/* New Campaign */}
      <div className="rounded-xl border border-slate-300 bg-white p-6">
        <StepHeader n={2} title={c.step2} body={c.step2Body} />

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Campaign name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">{c.campaignName}</label>
            <input
              type="text"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              placeholder={c.campaignNamePlaceholder}
              className="w-full rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Channel */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">{c.channel}</label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as 'sms' | 'whatsapp')}
              className="w-full rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            >
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </div>
        </div>

        {/* Campaign type: this is what decides whether the follow-up sweep ever touches these
            contacts. An offer sent three times is spam, and customers report it. */}
        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-slate-500">{c.campaignKind}</label>
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              { id: 'reminder' as const, title: c.kindReminder, body: c.kindReminderBody },
              { id: 'oneoff' as const, title: c.kindOneoff, body: c.kindOneoffBody },
            ]).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setCampaignType(opt.id)}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  campaignType === opt.id
                    ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                    : 'border-slate-300 bg-white hover:border-slate-400',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  <span
                    className={cn(
                      'inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2',
                      campaignType === opt.id ? 'border-blue-600 bg-blue-600' : 'border-slate-400 bg-white',
                    )}
                  />
                  {opt.title}
                </span>
                <span className="mt-1 block text-xs text-slate-500">{opt.body}</span>
              </button>
            ))}
          </div>

          {campaignType === 'reminder' ? (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-medium text-slate-700">{c.followUps}</p>
              <p className="mt-1 text-xs text-slate-500">{c.followUpsHelp}</p>
              {/* The chip is the number of days, not a sentence — the heading already says
                  "before the due date", so repeating it on every chip read as noise. Any custom
                  value the user adds joins the row rather than hiding behind the input. */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {[...new Set([30, 14, 7, 3, ...reminderStages])]
                  .sort((a, b) => b - a)
                  .map((d) => {
                    const on = reminderStages.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() =>
                          setReminderStages((prev) =>
                            prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((x, y) => y - x),
                          )
                        }
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                          on
                            ? 'border-blue-600 bg-blue-600 text-white'
                            : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400',
                        )}
                      >
                        {c.stageDays(d)}
                      </button>
                    );
                  })}

                {/* Custom point. Garages with a longer service interval ask for 45 and 90. */}
                <span className="flex items-center gap-1 rounded-full border border-dashed border-slate-300 bg-white px-2 py-0.5">
                  <span className="text-xs text-slate-500">{c.customLabel}</span>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={customStage}
                    onChange={(e) => setCustomStage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCustomStage();
                      }
                    }}
                    placeholder={c.customPlaceholder}
                    className="w-16 rounded border border-slate-200 px-1.5 py-0.5 text-xs text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={addCustomStage}
                    className="rounded px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
                  >
                    {c.customAdd}
                  </button>
                </span>
              </div>

              {/* Say back what was chosen, in a sentence. The chips alone don't tell you what
                  actually happens to a customer. */}
              <p className="mt-3 text-xs text-slate-600">
                {reminderStages.length > 0
                  ? c.followUpsSummary([...reminderStages].sort((a, b) => b - a))
                  : c.followUpsNone}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">{c.oneoffNote}</p>
          )}
        </div>

        {/* Template selector (WhatsApp only) */}
        {channel === 'whatsapp' && (
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-slate-500">
              {c.messageTemplate}{' '}
              <span className="text-slate-500">{c.templateOptional}</span>
            </label>
            <select
              value={selectedTemplateId}
              onChange={(e) => {
                setSelectedTemplateId(e.target.value);
                setVariableMapping({});
              }}
              className="w-full rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            >
              <option value="">{c.useDefault}</option>
              {approvedTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {approvedTemplates.length === 0 && (
              <p className="mt-1 text-xs text-slate-500">
                {c.noApprovedTemplates}{' '}
                <a href="#templates" className="text-blue-500 hover:underline">{c.createApprove}</a>{' '}
                {c.toUseCustom}
              </p>
            )}

            {/* Variable mapping */}
            {selectedTemplate && templateVariables.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-300 bg-slate-50 p-3">
                <p className="mb-2 text-xs font-medium text-slate-600">{c.mapVariables}</p>
                <p className="mb-3 text-xs text-slate-500 font-mono bg-slate-100 rounded px-2 py-1">
                  {selectedTemplate.bodyText}
                </p>
                <div className="space-y-2">
                  {templateVariables.map((varNum) => (
                    <div key={varNum} className="flex items-center gap-3">
                      <span className="w-10 shrink-0 text-xs font-mono text-blue-400">{`{{${varNum}}}`}</span>
                      <select
                        value={variableMapping[varNum] || ''}
                        onChange={(e) => setVariableMapping((prev) => ({ ...prev, [varNum]: e.target.value }))}
                        className="flex-1 rounded border border-slate-300 bg-slate-100 px-2 py-1 text-xs text-slate-900 focus:border-blue-500 focus:outline-none"
                      >
                        <option value="">{c.selectColumn}</option>
                        <option value="customer_name">customer_name {lang === 'fr' ? '(prénom)' : '(first name)'}</option>
                        <option value="full_name">full_name</option>
                        <option value="phone">phone</option>
                        <option value="registration">registration</option>
                        <option value="mot_due_date">mot_due_date</option>
                        <option value="service_due_date">service_due_date</option>
                        <option value="garage_name">garage_name</option>
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Source toggle: CSV upload or pull live from Garage Hive */}
        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-slate-500">{c.contactSource}</label>
          <div className="inline-flex rounded-lg border border-slate-300 p-0.5">
            {(['csv', 'garagehive'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSource(s);
                  setPreview(null);
                  setParseError(null);
                  setGhSkipped([]);
                }}
                className={cn(
                  'rounded-md px-4 py-1.5 text-xs font-medium transition-colors',
                  source === s ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-700',
                )}
              >
                {s === 'csv' ? c.csvUpload : 'Garage Hive'}
              </button>
            ))}
          </div>
        </div>

        {/* Automatic daily reminders */}
        {source === 'garagehive' && (
          ghSettings && !ghSettings.connected ? (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-800">{c.ghNotConnectedTitle}</p>
              <p className="mt-1 text-xs text-amber-700">
                {c.ghNotConnectedBody}
              </p>
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-slate-300 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{c.autoReminders}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {c.autoRemindersBody}
                  </p>
                </div>
                {/* Toggle */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoEnabled}
                  onClick={() => setAutoEnabled((v) => !v)}
                  className={cn(
                    'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                    autoEnabled ? 'bg-green-500' : 'bg-slate-300',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
                      autoEnabled ? 'translate-x-5' : 'translate-x-0.5',
                    )}
                  />
                </button>
              </div>

              <div className="mt-4 flex flex-wrap items-end gap-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-500">{c.remindWithin}</label>
                  <input
                    type="number"
                    min={0}
                    max={365}
                    value={autoDays}
                    onChange={(e) => setAutoDays(Number(e.target.value))}
                    className="w-24 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                  />
                </div>
                <div className="w-full md:min-w-[220px] md:flex-1">
                  <label className="mb-1 block text-xs font-medium text-slate-500">{c.whatsappTemplate}</label>
                  <select
                    value={autoTemplateId}
                    onChange={(e) => setAutoTemplateId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                  >
                    <option value="">{c.selectApproved}</option>
                    {approvedTemplates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    saveSettingsMutation.mutate({
                      garageId,
                      remindersEnabled: autoEnabled,
                      reminderDaysAhead: autoDays,
                      reminderTemplateId: autoTemplateId || null,
                    })
                  }
                  disabled={saveSettingsMutation.isPending}
                  className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {saveSettingsMutation.isPending ? c.saving : c.save}
                </button>
              </div>

              {approvedTemplates.length === 0 && (
                <p className="mt-3 text-xs text-amber-600">
                  {c.noApprovedWhatsapp}
                </p>
              )}
              <div className="mt-3 flex items-center gap-2 text-xs">
                <span className={cn('inline-block h-2 w-2 rounded-full', autoEnabled ? 'bg-green-500' : 'bg-slate-400')} />
                <span className="text-slate-500">
                  {ghSettings?.remindersEnabled ? c.autoOn : c.autoOff}
                  {ghSettings?.lastRunAt && c.lastRun(new Date(ghSettings.lastRunAt).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB'))}
                  {ghSettings?.lastRunError && c.lastError(ghSettings.lastRunError)}
                </span>
              </div>
            </div>
          )
        )}

        {/* Manual one-off pull (ad-hoc / preview) */}
        {source === 'garagehive' && (
          <div className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-4">
            <p className="mb-3 text-xs text-slate-500">
              <span className="font-medium text-slate-600">{c.oneOffLead}</span> {c.oneOffBody}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">{c.dueWithin}</label>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={ghDays}
                  onChange={(e) => setGhDays(Number(e.target.value))}
                  className="w-24 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                />
              </div>
              <button
                type="button"
                onClick={handlePullFromGarageHive}
                disabled={ghLoading}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {ghLoading ? c.fetching : c.pullFromGh}
              </button>
            </div>
            {ghSkipped.length > 0 && (
              <p className="mt-3 text-xs text-amber-600">
                {c.vehiclesSkipped(ghSkipped.length)}
              </p>
            )}
          </div>
        )}

        {/* CSV Upload */}
        <div className={cn('mt-4', source !== 'csv' && 'hidden')}>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs font-medium text-slate-500">
              {c.customerCsv}{' '}
              <span className="text-slate-500">
                {c.csvColumns}
              </span>
            </label>
            <button
              type="button"
              onClick={() => {
                const sample = [
                  'customer_name,phone,registration,mot_due_date,service_due_date',
                  'John Smith,+447911123456,AB12CDE,15-Apr-26,',
                  'Sarah Jones,+447922654321,XY21FGH,,20-May-26',
                ].join('\r\n');
                const blob = new Blob([sample], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'outbound_template.csv';
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
            >
              {c.downloadSample}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="block w-full cursor-pointer rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-500 file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-slate-700 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white hover:border-slate-500"
          />
          {parseError && (
            <p className="mt-2 text-xs text-red-400">{parseError}</p>
          )}
        </div>

      </div>

      {/* Step 3 — review and send. Its own card because it is a decision point, not another
          field on the form: this is the last screen before real customers get a message. */}
      {preview && preview.length > 0 && (
        <div className="rounded-xl border border-slate-300 bg-white p-6">
          <StepHeader n={3} title={c.step3} body={c.step3Body} />
          <div>
            <p className="mb-2 text-xs text-slate-500">
              {c.contactsPreview(preview.length, source === 'garagehive')}
            </p>
            <div className="overflow-x-auto rounded-lg border border-slate-300">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100 text-slate-500">
                  <tr>
                    <th className="px-3 py-2">{c.colName}</th>
                    <th className="px-3 py-2">{c.colPhone}</th>
                    <th className="px-3 py-2">{c.colReg}</th>
                    <th className="px-3 py-2">{c.colMotDue}</th>
                    <th className="px-3 py-2">{c.colServiceDue}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {preview.slice(0, 10).map((c, i) => (
                    <tr key={i} className="text-slate-600">
                      <td className="px-3 py-2">{c.customerName}</td>
                      <td className="px-3 py-2">{c.phone}</td>
                      <td className="px-3 py-2">{c.registration || '—'}</td>
                      <td className="px-3 py-2">{c.motDueDate || '—'}</td>
                      <td className="px-3 py-2">{c.serviceDueDate || '—'}</td>
                    </tr>
                  ))}
                  {preview.length > 10 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-2 text-center text-slate-500">
                        {c.andMore(preview.length - 10)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex gap-3">
              <button
                onClick={handleImportAndSend}
                disabled={createMutation.isPending || sendingId !== null}
                className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {createMutation.isPending || sendingId !== null ? c.sending : c.sendReminders(preview.length)}
              </button>
              <button
                onClick={resetForm}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-500 hover:text-slate-700"
              >
                {c.cancel}
              </button>
            </div>
            {limits && (
              <p className="mt-3 text-xs text-slate-600">
                <span className={cn('font-medium', limits.remaining === 0 ? 'text-amber-700' : 'text-slate-800')}>
                  {limits.remaining === 0 ? c.allowanceNone : c.allowanceLeft(limits.remaining)}
                </span>
                {' '}{c.allowanceUsed(limits.sentLast24h, limits.dailyLimit)}.
              </p>
            )}
            <p className="mt-3 text-xs text-slate-500">{c.howFooter}</p>
          </div>
        </div>
      )}

      {/* Past campaigns */}
      <div>
        <StepHeader n={4} title={c.step4} body={c.step4Body} />

        {isLoading ? (
          <p className="text-sm text-slate-500">{c.loadingCampaigns}</p>
        ) : campaigns.length === 0 ? (
          <p className="text-sm text-slate-500">{c.noCampaigns}</p>
        ) : (
          <>
          {/* Mobile: campaign cards (desktop keeps the table below) */}
          <div className="space-y-2 md:hidden">
            {campaigns.map((camp) => {
              const rate = camp.totalContacts > 0 ? Math.round((camp.sentCount / camp.totalContacts) * 100) : 0;
              const pending = camp.status === 'draft' || camp.status === 'sending';
              return (
                <button
                  key={camp.id}
                  type="button"
                  onClick={() => handleViewResults(camp)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-300 p-3 text-left hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{camp.name}</p>
                    <p className="mt-0.5 text-xs capitalize text-slate-500">
                      {camp.channel} · {camp.totalContacts} · {new Date(camp.createdAt).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB')}
                    </p>
                    {!pending ? (
                      <p className="mt-0.5 text-xs text-slate-500">
                        {rate}% ({camp.sentCount}/{camp.totalContacts})
                        {camp.replyCount ? ` · ${camp.replyCount} ${c.thReplies.toLowerCase()}` : ''}
                        {camp.bookedCount ? ` · ${camp.bookedCount} ${c.thBooked.toLowerCase()}` : ''}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        STATUS_COLORS[camp.status] || 'bg-slate-500/20 text-slate-600',
                      )}
                    >
                      {STATUS_LABELS[lang][camp.status] ?? camp.status}
                    </span>
                    {camp.status === 'queued' && camp.resumeAt && (
                      <p className="mt-0.5 text-[10px] text-blue-400">
                        Next: {new Date(camp.resumeAt).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { timeStyle: 'short' })}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-slate-300 md:block">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-slate-100 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3">{c.thName}</th>
                  <th className="px-4 py-3">{c.thChannel}</th>
                  <th className="px-4 py-3">{c.thContacts}</th>
                  <th className="px-4 py-3">{c.thSentRate}</th>
                  <th className="px-4 py-3">{c.thReplies}</th>
                  <th className="px-4 py-3">{c.thBooked}</th>
                  <th className="px-4 py-3">{c.thStatus}</th>
                  <th className="px-4 py-3">{c.thDate}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {campaigns.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => handleViewResults(c)}
                    className="cursor-pointer text-slate-600 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">{c.name}</td>
                    <td className="px-4 py-3 capitalize">{c.channel}</td>
                    <td className="px-4 py-3">{c.totalContacts}</td>
                    <td className="px-4 py-3">
                      {c.status === 'draft' || c.status === 'sending' ? (
                        <span className="text-slate-500 text-xs">—</span>
                      ) : (
                        (() => {
                          const rate = c.totalContacts > 0 ? Math.round((c.sentCount / c.totalContacts) * 100) : 0;
                          const color = rate === 100 ? 'text-green-400' : rate >= 50 ? 'text-yellow-400' : 'text-red-400';
                          return (
                            <span className={`text-sm font-medium ${color}`}>
                              {rate}%
                              <span className="ml-1 text-xs text-slate-500">({c.sentCount}/{c.totalContacts})</span>
                            </span>
                          );
                        })()
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {c.replyCount ? (
                        <span className="font-medium text-purple-600">{c.replyCount}</span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {c.bookedCount ? (
                        <span className="font-medium text-green-600">{c.bookedCount}</span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          STATUS_COLORS[c.status] || 'bg-slate-500/20 text-slate-600',
                        )}
                      >
                        {STATUS_LABELS[lang][c.status] ?? c.status}
                      </span>
                      {c.status === 'queued' && c.resumeAt && (
                        <p className="mt-0.5 text-[10px] text-blue-400">
                          Next batch: {new Date(c.resumeAt).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(c.createdAt).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>

      {/* Campaign Results Modal */}
      {(selectedCampaign || loadingContacts) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setSelectedCampaign(null)}
        >
          <div
            className="w-full max-w-2xl rounded-xl border border-slate-300 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-slate-300 px-6 py-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  {selectedCampaign?.name ?? c.loadingModal}
                </h2>
                {selectedCampaign && (
                  <>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {c.sentTotal(
                        selectedCampaign.sentCount,
                        selectedCampaign.totalContacts,
                        new Date(selectedCampaign.createdAt).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB'),
                      )}
                    </p>
                    {selectedCampaign.status === 'queued' && selectedCampaign.resumeAt && (
                      <p className="mt-0.5 text-xs text-blue-500">
                        Next batch: {new Date(selectedCampaign.resumeAt).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                        {' '}({selectedCampaign.totalContacts - selectedCampaign.sentCount} remaining)
                      </p>
                    )}
                  </>
                )}
              </div>
              <button
                onClick={() => setSelectedCampaign(null)}
                className="rounded p-1 text-slate-500 hover:text-slate-700"
              >
                ✕
              </button>
            </div>

            {/* Delivery / open / reply report */}
            {selectedCampaign?.contacts?.length ? (
              (() => {
                const contacts = selectedCampaign.contacts!;
                const count = (fn: (s: string) => boolean) => contacts.filter((c) => fn(c.status)).length;
                // Statuses are progressive (read implies delivered) — count cumulatively.
                const sent = count((s) => ['sent', 'delivered', 'read', 'replied'].includes(s));
                const delivered = count((s) => ['delivered', 'read', 'replied'].includes(s));
                const read = count((s) => ['read', 'replied'].includes(s));
                const replied = count((s) => ['replied', 'booked'].includes(s));
                const failed = count((s) => s === 'failed');
                // A booking is recorded on the conversation, not the contact row.
                const booked = contacts.filter((ct) => ct.conversation?.confirmedBooking).length;
                const pct = (n: number) => (sent ? Math.round((n / sent) * 100) : 0);
                const stat = (label: string, n: number, showPct = true) => (
                  <div className="flex-1 text-center">
                    <p className="text-lg font-semibold text-slate-900">{n}</p>
                    <p className="text-[11px] text-slate-500">
                      {label}
                      {showPct && sent ? ` · ${pct(n)}%` : ''}
                    </p>
                  </div>
                );
                return (
                  <div className="flex items-stretch gap-1 border-b border-slate-200 bg-slate-50 px-6 py-3">
                    {stat(c.statSent, sent, false)}
                    {stat(c.statDelivered, delivered)}
                    {stat(c.statRead, read)}
                    {stat(c.statReplied, replied)}
                    {stat(c.statBooked, booked)}
                    {failed > 0 && stat(c.statFailed, failed)}
                  </div>
                );
              })()
            ) : null}

            {/* Modal body */}
            <div className="max-h-[60vh] overflow-y-auto">
              {loadingContacts ? (
                <p className="px-6 py-8 text-center text-sm text-slate-500">{c.loadingContacts}</p>
              ) : !selectedCampaign?.contacts?.length ? (
                <p className="px-6 py-8 text-center text-sm text-slate-500">{c.noContacts}</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-slate-100 text-xs text-slate-500">
                    <tr>
                      <th className="px-4 py-2">{c.colName}</th>
                      <th className="px-4 py-2">{c.colPhone}</th>
                      <th className="px-4 py-2">{c.thStatus}</th>
                      <th className="px-4 py-2">{c.cOutcome}</th>
                      <th className="px-4 py-2">{c.cDetail}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {selectedCampaign.contacts!.map((contact) => {
                      const statusColor: Record<string, string> = {
                        pending: 'text-yellow-400',
                        sent: 'text-blue-400',
                        delivered: 'text-green-400',
                        read: 'text-green-300',
                        replied: 'text-purple-400',
                        booked: 'text-green-500',
                        failed: 'text-red-400',
                        expired: 'text-slate-400',
                        opted_out: 'text-slate-500',
                      };
                      const conv = contact.conversation;
                      // bookingDetails is the agent's own summary, e.g. "MOT Class 4 on
                      // 2026-08-04 at 09:00" — shown as written rather than re-parsed, so it
                      // can't disagree with what the customer was told.
                      const outcome = conv?.confirmedBooking
                        ? { label: c.outcomeBooked, detail: conv.bookingDetails || '', tone: 'text-green-600' }
                        : conv
                          ? {
                              label: c.outcomeReplied,
                              detail: new Date(conv.lastMessageAt).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }),
                              tone: 'text-purple-600',
                            }
                          : null;
                      const statusLabel: Record<string, string> = c.statusLabels;
                      return (
                        <tr key={contact.id} className="text-slate-600">
                          <td className="px-4 py-2">{contact.customerName}</td>
                          <td className="px-4 py-2 font-mono text-xs">{contact.phone}</td>
                          <td className={`px-4 py-2 text-xs font-medium ${statusColor[contact.status] ?? 'text-slate-500'}`}>
                            {statusLabel[contact.status] ?? contact.status}
                          </td>
                          <td className="px-4 py-2 text-xs">
                            {outcome ? (
                              <a
                                href={`/messages?conversation=${conv!.id}`}
                                title={c.openConversation}
                                className="hover:underline"
                              >
                                <span className={cn('font-medium', outcome.tone)}>{outcome.label}</span>
                                {outcome.detail && (
                                  <span className="block text-[11px] text-slate-500">{outcome.detail}</span>
                                )}
                              </a>
                            ) : (
                              <span className="text-slate-400">{c.outcomeAwaiting}</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-xs text-slate-500">
                            {contact.errorReason || '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
