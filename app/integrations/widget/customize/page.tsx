'use client';

import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { getGarageId, TOKEN_STORAGE_KEY } from '@/app/lib/auth';
import { useRouter } from 'next/navigation';
import { useLang } from '@/app/i18n/LocaleProvider';

interface WidgetBranding {
  widgetLogoUrl: string | null;
  widgetLogoWidth: number;
  widgetLogoHeight: number;
  widgetPrimaryColor: string | null;
  widgetButtonColor: string | null;
  widgetButtonShape: string;
  widgetButtonIcon: string;
}

const DEFAULT_COLOR = '#2563eb';

const PRESET_COLORS = [
  { name: 'Blue', value: '#2563eb' },
  { name: 'Green', value: '#10b981' },
  { name: 'Purple', value: '#8b5cf6' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Pink', value: '#ec4899' },
];

const BUTTON_SHAPES = [
  { name: 'Circle', value: 'circle' },
  { name: 'Pill', value: 'pill' },
  { name: 'Rounded', value: 'rounded' },
  { name: 'Square', value: 'square' },
];

const BUTTON_ICONS = [
  { name: 'Chat Bubble', value: 'chat' },
  { name: 'WhatsApp', value: 'whatsapp' },
  { name: 'Phone', value: 'phone' },
];

export default function WidgetCustomizePage() {
  const router = useRouter();
  const lang = useLang();
  const c = {
    en: {
      notAuthed: 'Not authenticated',
      updateSuccess: 'Widget branding updated successfully!',
      saveFailed: 'Failed to save branding',
      uploadImage: 'Please upload an image file',
      imageTooLarge: 'Image must be less than 2MB',
      readFailed: 'Failed to read image file',
      processFailed: 'Failed to process image',
      garageNotSelected: 'Garage not selected. Please log in again.',
      loadingBranding: 'Loading widget branding...',
      pageTitle: 'Widget Customization',
      pageSubtitle: 'Customize your chat widget with your brand colors and logo',
      logo: 'Logo',
      logoHint: 'Upload your logo to display at the top of the widget menu',
      removeLogo: 'Remove Logo',
      processing: 'Processing…',
      clickToUpload: 'Click to upload logo',
      fileHint: 'PNG, JPG, SVG up to 2MB',
      logoWidth: (px: number) => `Logo Width: ${px}px`,
      logoHeight: (px: number) => `Logo Height: ${px}px`,
      buttonShape: 'Button Shape',
      buttonShapeHint: 'Choose the shape of the chat button',
      buttonIcon: 'Button Icon',
      buttonIconHint: 'Select the icon displayed on the chat button',
      widgetColor: 'Widget Color',
      widgetColorHint: 'Choose the main color for your widget interface',
      buttonColor: 'Button Color',
      buttonColorHint: 'Choose a separate color for the chat button (optional, defaults to widget color)',
      buttonColorPlaceholder: 'Leave empty to use widget color',
      clearUseWidget: 'Clear (use widget color)',
      savingChanges: 'Saving...',
      saveChanges: 'Save Changes',
      reset: 'Reset',
      preview: 'Preview',
      previewHint: 'See how your widget will look with your customizations',
      logoPreviewAlt: 'Logo preview',
      logoAlt: 'Logo',
      chatButton: 'Chat Button',
      chatNow: 'Chat now!',
      widgetMenu: 'Widget Menu',
      messageUsOn: 'Message us on...',
      liveChat: 'Live Chat',
      phone: 'Phone',
      poweredBy: 'Powered by',
      shapeNames: { circle: 'Circle', pill: 'Pill', rounded: 'Rounded', square: 'Square' } as Record<string, string>,
      iconNames: { chat: 'Chat Bubble', whatsapp: 'WhatsApp', phone: 'Phone' } as Record<string, string>,
    },
    fr: {
      notAuthed: 'Non authentifié',
      updateSuccess: 'Personnalisation du widget mise à jour avec succès !',
      saveFailed: "Échec de l'enregistrement de la personnalisation",
      uploadImage: 'Veuillez importer un fichier image',
      imageTooLarge: "L'image doit faire moins de 2 Mo",
      readFailed: "Échec de la lecture du fichier image",
      processFailed: "Échec du traitement de l'image",
      garageNotSelected: 'Aucun garage sélectionné. Veuillez vous reconnecter.',
      loadingBranding: 'Chargement de la personnalisation du widget...',
      pageTitle: 'Personnalisation du widget',
      pageSubtitle: 'Personnalisez votre widget de chat avec les couleurs et le logo de votre marque',
      logo: 'Logo',
      logoHint: 'Importez votre logo pour l\'afficher en haut du menu du widget',
      removeLogo: 'Retirer le logo',
      processing: 'Traitement…',
      clickToUpload: 'Cliquez pour importer un logo',
      fileHint: "PNG, JPG, SVG jusqu'à 2 Mo",
      logoWidth: (px: number) => `Largeur du logo : ${px}px`,
      logoHeight: (px: number) => `Hauteur du logo : ${px}px`,
      buttonShape: 'Forme du bouton',
      buttonShapeHint: 'Choisissez la forme du bouton de chat',
      buttonIcon: 'Icône du bouton',
      buttonIconHint: "Sélectionnez l'icône affichée sur le bouton de chat",
      widgetColor: 'Couleur du widget',
      widgetColorHint: "Choisissez la couleur principale de l'interface de votre widget",
      buttonColor: 'Couleur du bouton',
      buttonColorHint: 'Choisissez une couleur distincte pour le bouton de chat (facultatif, la couleur du widget est utilisée par défaut)',
      buttonColorPlaceholder: 'Laissez vide pour utiliser la couleur du widget',
      clearUseWidget: 'Effacer (utiliser la couleur du widget)',
      savingChanges: 'Enregistrement...',
      saveChanges: 'Enregistrer les modifications',
      reset: 'Réinitialiser',
      preview: 'Aperçu',
      previewHint: 'Découvrez à quoi ressemblera votre widget avec vos personnalisations',
      logoPreviewAlt: 'Aperçu du logo',
      logoAlt: 'Logo',
      chatButton: 'Bouton de chat',
      chatNow: 'Discutez maintenant !',
      widgetMenu: 'Menu du widget',
      messageUsOn: 'Écrivez-nous sur...',
      liveChat: 'Chat en direct',
      phone: 'Téléphone',
      poweredBy: 'Propulsé par',
      shapeNames: { circle: 'Cercle', pill: 'Pilule', rounded: 'Arrondi', square: 'Carré' } as Record<string, string>,
      iconNames: { chat: 'Bulle de chat', whatsapp: 'WhatsApp', phone: 'Téléphone' } as Record<string, string>,
    },
  }[lang];
  const garageId = getGarageId();
  const [hasMessagingAccess, setHasMessagingAccess] = useState<boolean | null>(null);
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoWidth, setLogoWidth] = useState<number>(120);
  const [logoHeight, setLogoHeight] = useState<number>(60);
  const [primaryColor, setPrimaryColor] = useState<string>(DEFAULT_COLOR);
  const [buttonColor, setButtonColor] = useState<string>('');
  const [buttonShape, setButtonShape] = useState<string>('circle');
  const [buttonIcon, setButtonIcon] = useState<string>('chat');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackIsError, setFeedbackIsError] = useState<boolean>(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch current branding
  const { data: brandingData, isLoading } = useQuery({
    queryKey: ['widget-branding', garageId],
    queryFn: async () => {
      const response = await fetch(`/api/widget/${garageId}`);
      if (!response.ok) throw new Error('Failed to fetch branding');
      return response.json();
    },
    enabled: !!garageId,
  });

  useEffect(() => {
    if (brandingData) {
      setLogoUrl(brandingData.logoUrl || '');
      setLogoWidth(brandingData.logoWidth || 120);
      setLogoHeight(brandingData.logoHeight || 60);
      setPrimaryColor(brandingData.primaryColor || DEFAULT_COLOR);
      setButtonColor(brandingData.buttonColor || '');
      setButtonShape(brandingData.buttonShape || 'circle');
      setButtonIcon(brandingData.buttonIcon || 'chat');
      setImagePreview(brandingData.logoUrl || null);
    }
  }, [brandingData]);

  // Check messaging access on mount
  useEffect(() => {
    const checkAccess = async () => {
      if (!garageId) {
        router.push('/login');
        return;
      }

      try {
        const token = localStorage.getItem(TOKEN_STORAGE_KEY);
        if (!token) {
          router.push('/login');
          return;
        }

        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/api/garages/${garageId}/messaging-access`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          const hasAccess = data.hasMessagingAccess || false;
          setHasMessagingAccess(hasAccess);

          if (!hasAccess) {
            router.push('/dashboard');
          }
        } else {
          router.push('/dashboard');
        }
      } catch (error) {
        console.error('Error checking messaging access:', error);
        router.push('/dashboard');
      }
    };

    void checkAccess();
  }, [garageId, router]);

  // Save branding mutation
  const saveMutation = useMutation({
    mutationFn: async (data: WidgetBranding) => {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        throw new Error(c.notAuthed);
      }

      const response = await fetch(`/api/widget/${garageId}/branding`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || c.saveFailed);
      }
      return response.json();
    },
    onSuccess: () => {
      setFeedbackIsError(false);
      setFeedback(c.updateSuccess);
      setTimeout(() => setFeedback(null), 3000);
    },
    onError: (error: any) => {
      setFeedbackIsError(true);
      setFeedback(error.message || c.saveFailed);
    },
  });

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setFeedbackIsError(true);
      setFeedback(c.uploadImage);
      return;
    }

    // Validate file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
      setFeedbackIsError(true);
      setFeedback(c.imageTooLarge);
      return;
    }

    setUploadingImage(true);
    setFeedback(null);

    try {
      // There's no object storage — the logo is stored inline (data URL) on the branding record.
      // So downscale + recompress client-side to keep that string small (a full-size photo would
      // bloat every widget-config payload). Cap the longest edge at 320px, plenty for a widget logo.
      const reader = new FileReader();
      reader.onloadend = () => {
        const src = reader.result as string;
        const img = new Image();
        img.onload = () => {
          const MAX = 320;
          let { width, height } = img;
          if (width > MAX || height > MAX) {
            const scale = MAX / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          let out = src;
          try {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0, width, height);
              out = canvas.toDataURL('image/png'); // PNG keeps logo transparency
            }
          } catch {
            /* fall back to the original data URL if canvas export fails */
          }
          setImagePreview(out);
          setLogoUrl(out);
          setUploadingImage(false);
        };
        img.onerror = () => {
          setImagePreview(src);
          setLogoUrl(src);
          setUploadingImage(false);
        };
        img.src = src;
      };
      reader.onerror = () => {
        setFeedbackIsError(true);
        setFeedback(c.readFailed);
        setUploadingImage(false);
      };
      reader.readAsDataURL(file);
    } catch (error) {
      setFeedbackIsError(true);
      setFeedback(c.processFailed);
      setUploadingImage(false);
    }
  };

  const handleRemoveLogo = () => {
    setLogoUrl('');
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSave = () => {
    saveMutation.mutate({
      widgetLogoUrl: logoUrl || null,
      widgetLogoWidth: logoWidth,
      widgetLogoHeight: logoHeight,
      widgetPrimaryColor: primaryColor || null,
      widgetButtonColor: buttonColor || null,
      widgetButtonShape: buttonShape,
      widgetButtonIcon: buttonIcon,
    });
  };

  const handleReset = () => {
    setLogoUrl('');
    setLogoWidth(120);
    setLogoHeight(60);
    setPrimaryColor(DEFAULT_COLOR);
    setButtonColor('');
    setButtonShape('circle');
    setButtonIcon('chat');
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  if (!garageId) {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-6 text-sm text-amber-200">
        {c.garageNotSelected}
      </div>
    );
  }

  if (isLoading || hasMessagingAccess === null) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
        {c.loadingBranding}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">{c.pageTitle}</h1>
        <p className="text-sm text-slate-400 mt-1">
          {c.pageSubtitle}
        </p>
      </div>

      {feedback && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            !feedbackIsError
              ? 'border-green-500/30 bg-green-500/10 text-green-100'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
          }`}
        >
          {feedback}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Settings Panel */}
        <div className="space-y-6">
          {/* Logo Upload */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">{c.logo}</h2>
            <p className="text-sm text-slate-400 mb-4">
              {c.logoHint}
            </p>

            <div className="space-y-4">
              {imagePreview ? (
                <div className="relative">
                  <div className="flex items-center justify-center p-6 rounded-lg border border-slate-700 bg-slate-950">
                    <img
                      src={imagePreview}
                      alt={c.logoPreviewAlt}
                      className="max-h-24 max-w-full object-contain"
                    />
                  </div>
                  <button
                    onClick={handleRemoveLogo}
                    className="mt-3 w-full rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/20"
                  >
                    {c.removeLogo}
                  </button>
                </div>
              ) : (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                    id="logo-upload"
                  />
                  <label
                    htmlFor="logo-upload"
                    className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-700 bg-slate-950 p-8 transition hover:border-slate-600 hover:bg-slate-900"
                  >
                    <svg
                      className="h-12 w-12 text-slate-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                    <p className="mt-2 text-sm text-slate-300">
                      {uploadingImage ? c.processing : c.clickToUpload}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{c.fileHint}</p>
                  </label>
                </div>
              )}
            </div>

            {/* Logo Width Slider */}
            {imagePreview && (
              <div className="mt-4 pt-4 border-t border-slate-700 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-3">
                    {c.logoWidth(logoWidth)}
                  </label>
                  <input
                    type="range"
                    min="40"
                    max="200"
                    step="5"
                    value={logoWidth}
                    onChange={(e) => setLogoWidth(parseInt(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-500"
                  />
                  <div className="flex justify-between text-xs text-slate-500 mt-1">
                    <span>40px</span>
                    <span>200px</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-3">
                    {c.logoHeight(logoHeight)}
                  </label>
                  <input
                    type="range"
                    min="20"
                    max="150"
                    step="5"
                    value={logoHeight}
                    onChange={(e) => setLogoHeight(parseInt(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-500"
                  />
                  <div className="flex justify-between text-xs text-slate-500 mt-1">
                    <span>20px</span>
                    <span>150px</span>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Button Shape */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">{c.buttonShape}</h2>
            <p className="text-sm text-slate-400 mb-4">
              {c.buttonShapeHint}
            </p>

            <div className="grid grid-cols-3 gap-3">
              {BUTTON_SHAPES.map((shape) => (
                <button
                  key={shape.value}
                  onClick={() => setButtonShape(shape.value)}
                  className={`relative rounded-lg border-2 p-4 text-center transition ${
                    buttonShape === shape.value
                      ? 'border-sky-500 bg-sky-500/10'
                      : 'border-slate-700 hover:border-slate-600 hover:bg-slate-800'
                  }`}
                >
                  <div className="flex justify-center mb-2">
                    <div
                      className="w-12 h-12 flex items-center justify-center text-white"
                      style={{
                        backgroundColor: primaryColor,
                        borderRadius: shape.value === 'circle' ? '50%' : shape.value === 'rounded' ? '12px' : '4px',
                      }}
                    >
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                      </svg>
                    </div>
                  </div>
                  <span className="text-sm font-medium text-slate-300">{c.shapeNames[shape.value] ?? shape.name}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Button Icon */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">{c.buttonIcon}</h2>
            <p className="text-sm text-slate-400 mb-4">
              {c.buttonIconHint}
            </p>

            <div className="grid grid-cols-3 gap-3">
              {BUTTON_ICONS.map((icon) => (
                <button
                  key={icon.value}
                  onClick={() => setButtonIcon(icon.value)}
                  className={`relative rounded-lg border-2 p-4 text-center transition ${
                    buttonIcon === icon.value
                      ? 'border-sky-500 bg-sky-500/10'
                      : 'border-slate-700 hover:border-slate-600 hover:bg-slate-800'
                  }`}
                >
                  <div className="flex justify-center mb-2">
                    <div
                      className="w-12 h-12 flex items-center justify-center text-white rounded-full"
                      style={{ backgroundColor: primaryColor }}
                    >
                      {icon.value === 'chat' && (
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                      )}
                      {icon.value === 'whatsapp' && (
                        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                        </svg>
                      )}
                      {icon.value === 'phone' && (
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                        </svg>
                      )}
                    </div>
                  </div>
                  <span className="text-sm font-medium text-slate-300">{c.iconNames[icon.value] ?? icon.name}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Widget Color Picker */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">{c.widgetColor}</h2>
            <p className="text-sm text-slate-400 mb-4">
              {c.widgetColorHint}
            </p>

            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <input
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="h-12 w-20 cursor-pointer rounded-lg border border-slate-700"
                />
                <input
                  type="text"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  placeholder="#2563eb"
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-6 gap-2">
                {['#2563eb', '#7c3aed', '#dc2626', '#ea580c', '#16a34a', '#0891b2'].map((color) => (
                  <button
                    key={color}
                    onClick={() => setPrimaryColor(color)}
                    className="h-10 w-full rounded-lg border-2 transition hover:scale-105"
                    style={{
                      backgroundColor: color,
                      borderColor: primaryColor === color ? '#fff' : color,
                    }}
                  />
                ))}
              </div>
            </div>
          </section>

          {/* Button Color Picker */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">{c.buttonColor}</h2>
            <p className="text-sm text-slate-400 mb-4">
              {c.buttonColorHint}
            </p>

            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <input
                  type="color"
                  value={buttonColor || primaryColor}
                  onChange={(e) => setButtonColor(e.target.value)}
                  className="h-12 w-20 cursor-pointer rounded-lg border border-slate-700"
                />
                <input
                  type="text"
                  value={buttonColor}
                  onChange={(e) => setButtonColor(e.target.value)}
                  placeholder={c.buttonColorPlaceholder}
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-6 gap-2">
                {['#2563eb', '#7c3aed', '#dc2626', '#ea580c', '#16a34a', '#0891b2'].map((color) => (
                  <button
                    key={color}
                    onClick={() => setButtonColor(color)}
                    className="h-10 w-full rounded-lg border-2 transition hover:scale-105"
                    style={{
                      backgroundColor: color,
                      borderColor: buttonColor === color ? '#fff' : color,
                    }}
                  />
                ))}
              </div>
              
              {buttonColor && (
                <button
                  onClick={() => setButtonColor('')}
                  className="w-full text-sm text-slate-400 hover:text-slate-300 transition"
                >
                  {c.clearUseWidget}
                </button>
              )}
            </div>
          </section>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="flex-1 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saveMutation.isPending ? c.savingChanges : c.saveChanges}
            </button>
            <button
              onClick={handleReset}
              disabled={saveMutation.isPending}
              className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {c.reset}
            </button>
          </div>
        </div>

        {/* Preview Panel */}
        <div className="lg:sticky lg:top-6">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">{c.preview}</h2>
            <p className="text-sm text-slate-400 mb-6">
              {c.previewHint}
            </p>

            {/* Widget Preview */}
            <div className="space-y-6">
              {/* Floating Button Preview */}
              <div className="flex items-center justify-center">
                <div className="relative">
                  <p className="text-xs text-slate-400 text-center mb-3">{c.chatButton}</p>
                  {buttonShape === 'pill' ? (
                    <button
                      className="shadow-2xl transition hover:scale-105 flex items-center justify-center text-white gap-2 px-6"
                      style={{
                        backgroundColor: buttonColor || primaryColor,
                        height: '64px',
                        borderRadius: '32px',
                        minWidth: '180px',
                      }}
                    >
                      {buttonIcon === 'chat' && (
                        <>
                          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                          </svg>
                          <span className="font-medium">{c.chatNow}</span>
                        </>
                      )}
                      {buttonIcon === 'whatsapp' && (
                        <>
                          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                          </svg>
                          <span className="font-medium">{c.chatNow}</span>
                        </>
                      )}
                      {buttonIcon === 'phone' && (
                        <>
                          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                          </svg>
                          <span className="font-medium">{c.chatNow}</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      className="shadow-2xl transition hover:scale-105 flex items-center justify-center text-white"
                      style={{
                        backgroundColor: buttonColor || primaryColor,
                        width: '64px',
                        height: '64px',
                        borderRadius: buttonShape === 'circle' ? '50%' : buttonShape === 'rounded' ? '16px' : '8px',
                      }}
                    >
                      {buttonIcon === 'chat' && (
                        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                      )}
                      {buttonIcon === 'whatsapp' && (
                        <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                        </svg>
                      )}
                      {buttonIcon === 'phone' && (
                        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                        </svg>
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* Widget Menu Preview */}
              <div>
                <p className="text-xs text-slate-400 text-center mb-3">{c.widgetMenu}</p>
                <div
                  className="relative mx-auto rounded-3xl p-8 shadow-2xl"
                  style={{
                    backgroundColor: primaryColor,
                    maxWidth: '380px',
                  }}
                >
                  {/* Logo Preview */}
                  <div className="mb-6 flex justify-center">
                    {imagePreview ? (
                      <img
                        src={imagePreview}
                        alt={c.logoAlt}
                        style={{
                          width: `${logoWidth}px`,
                          height: `${logoHeight}px`,
                          objectFit: 'contain'
                        }}
                      />
                    ) : (
                      <div className="flex items-center justify-center rounded-2xl bg-white/10 backdrop-blur-sm" style={{ height: `${logoHeight}px`, width: `${logoWidth}px` }}>
                        <svg className="text-white/50" style={{ height: `${logoHeight * 0.5}px`, width: `${logoWidth * 0.5}px` }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* Menu Content */}
                  <div className="space-y-3 rounded-2xl bg-white p-5">
                    <h4 className="mb-4 text-center text-lg font-medium text-gray-900">{c.messageUsOn}</h4>
                
                    {/* WhatsApp Button */}
                    <div className="flex items-center gap-3 rounded-2xl border-2 border-green-400 bg-white p-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500">
                        <svg className="h-6 w-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                        </svg>
                      </div>
                      <span className="font-medium text-gray-900">WhatsApp</span>
                    </div>

                    {/* Live Chat Button */}
                    <div className="flex items-center gap-3 rounded-2xl border-2 p-4" style={{ borderColor: primaryColor }}>
                      <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: primaryColor }}>
                        <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <span className="font-medium text-gray-900">{c.liveChat}</span>
                    </div>

                    {/* Phone Button */}
                    <div className="flex items-center gap-3 rounded-2xl border-2 p-4" style={{ borderColor: primaryColor }}>
                      <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: primaryColor }}>
                        <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                        </svg>
                      </div>
                      <span className="font-medium text-gray-900">{c.phone}</span>
                    </div>

                    <p className="mt-4 text-center text-xs text-gray-400">
                      {c.poweredBy} <span className="font-medium text-gray-600">ReceptionMate</span>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}