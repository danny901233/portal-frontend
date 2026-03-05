'use client';

import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { getGarageId, TOKEN_STORAGE_KEY } from '@/app/lib/auth';

interface WidgetBranding {
  widgetLogoUrl: string | null;
  widgetLogoSize: number;
  widgetPrimaryColor: string | null;
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
  { name: 'Rounded', value: 'rounded' },
  { name: 'Square', value: 'square' },
];

const BUTTON_ICONS = [
  { name: 'Chat Bubble', value: 'chat' },
  { name: 'WhatsApp', value: 'whatsapp' },
  { name: 'Phone', value: 'phone' },
];

export default function WidgetCustomizePage() {
  const garageId = getGarageId();
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoSize, setLogoSize] = useState<number>(80);
  const [primaryColor, setPrimaryColor] = useState<string>(DEFAULT_COLOR);
  const [buttonShape, setButtonShape] = useState<string>('circle');
  const [buttonIcon, setButtonIcon] = useState<string>('chat');
  const [feedback, setFeedback] = useState<string | null>(null);
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
      setLogoSize(brandingData.logoSize || 80);
      setPrimaryColor(brandingData.primaryColor || DEFAULT_COLOR);
      setButtonShape(brandingData.buttonShape || 'circle');
      setButtonIcon(brandingData.buttonIcon || 'chat');
      setImagePreview(brandingData.logoUrl || null);
    }
  }, [brandingData]);

  // Save branding mutation
  const saveMutation = useMutation({
    mutationFn: async (data: WidgetBranding) => {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        throw new Error('Not authenticated');
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
        throw new Error(error.error || 'Failed to save branding');
      }
      return response.json();
    },
    onSuccess: () => {
      setFeedback('Widget branding updated successfully!');
      setTimeout(() => setFeedback(null), 3000);
    },
    onError: (error: any) => {
      setFeedback(error.message || 'Failed to save branding');
    },
  });

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setFeedback('Please upload an image file');
      return;
    }

    // Validate file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
      setFeedback('Image must be less than 2MB');
      return;
    }

    setUploadingImage(true);
    setFeedback(null);

    try {
      // Convert to base64 for preview and storage
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        setImagePreview(base64String);
        setLogoUrl(base64String);
        setUploadingImage(false);
      };
      reader.onerror = () => {
        setFeedback('Failed to read image file');
        setUploadingImage(false);
      };
      reader.readAsDataURL(file);
    } catch (error) {
      setFeedback('Failed to upload image');
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
      widgetLogoSize: logoSize,
      widgetPrimaryColor: primaryColor || null,
      widgetButtonShape: buttonShape,
      widgetButtonIcon: buttonIcon,
    });
  };

  const handleReset = () => {
    setLogoUrl('');
    setLogoSize(80);
    setPrimaryColor(DEFAULT_COLOR);
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
        Garage not selected. Please log in again.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
        Loading widget branding...
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Widget Customization</h1>
        <p className="text-sm text-slate-400 mt-1">
          Customize your chat widget with your brand colors and logo
        </p>
      </div>

      {feedback && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            feedback.includes('success')
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
            <h2 className="text-lg font-semibold text-slate-100 mb-4">Logo</h2>
            <p className="text-sm text-slate-400 mb-4">
              Upload your logo to display at the top of the widget menu
            </p>

            <div className="space-y-4">
              {imagePreview ? (
                <div className="relative">
                  <div className="flex items-center justify-center p-6 rounded-lg border border-slate-700 bg-slate-950">
                    <img
                      src={imagePreview}
                      alt="Logo preview"
                      className="max-h-24 max-w-full object-contain"
                    />
                  </div>
                  <button
                    onClick={handleRemoveLogo}
                    className="mt-3 w-full rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/20"
                  >
                    Remove Logo
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
                      {uploadingImage ? 'Uploading...' : 'Click to upload logo'}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">PNG, JPG, SVG up to 2MB</p>
                  </label>
                </div>
              )}
            </div>

            {/* Logo Size Slider */}
            {imagePreview && (
              <div className="mt-4 pt-4 border-t border-slate-700">
                <label className="block text-sm font-medium text-slate-300 mb-3">
                  Logo Size: {logoSize}px
                </label>
                <input
                  type="range"
                  min="40"
                  max="150"
                  step="5"
                  value={logoSize}
                  onChange={(e) => setLogoSize(parseInt(e.target.value))}
                  className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-500"
                />
                <div className="flex justify-between text-xs text-slate-500 mt-1">
                  <span>Small</span>
                  <span>Large</span>
                </div>
              </div>
            )}
          </section>

          {/* Button Shape */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">Button Shape</h2>
            <p className="text-sm text-slate-400 mb-4">
              Choose the shape of the chat button
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
                  <span className="text-sm font-medium text-slate-300">{shape.name}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Button Icon */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">Button Icon</h2>
            <p className="text-sm text-slate-400 mb-4">
              Select the icon displayed on the chat button
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
                  <span className="text-sm font-medium text-slate-300">{icon.name}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Color Picker */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">Brand Color</h2>
            <p className="text-sm text-slate-400 mb-4">
              Choose a color that matches your brand identity
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

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="flex-1 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saveMutation.isPending ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              onClick={handleReset}
              disabled={saveMutation.isPending}
              className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Preview Panel */}
        <div className="lg:sticky lg:top-6">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">Preview</h2>
            <p className="text-sm text-slate-400 mb-6">
              See how your widget will look with your customizations
            </p>

            {/* Widget Preview */}
            <div className="space-y-6">
              {/* Floating Button Preview */}
              <div className="flex items-center justify-center">
                <div className="relative">
                  <p className="text-xs text-slate-400 text-center mb-3">Chat Button</p>
                  <button
                    className="shadow-2xl transition hover:scale-105 flex items-center justify-center text-white"
                    style={{
                      backgroundColor: primaryColor,
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
                </div>
              </div>

              {/* Widget Menu Preview */}
              <div>
                <p className="text-xs text-slate-400 text-center mb-3">Widget Menu</p>
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
                      <div className="rounded-2xl bg-white/10 p-4 backdrop-blur-sm">
                        <img
                          src={imagePreview}
                          alt="Logo"
                          style={{
                            maxHeight: `${logoSize}px`,
                            maxWidth: `${logoSize * 1.5}px`,
                            objectFit: 'contain'
                          }}
                        />
                      </div>
                    ) : (
                      <div className="flex items-center justify-center rounded-2xl bg-white/10 backdrop-blur-sm" style={{ height: `${logoSize}px`, width: `${logoSize * 1.5}px` }}>
                        <svg className="text-white/50" style={{ height: `${logoSize * 0.5}px`, width: `${logoSize * 0.5}px` }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
                <h4 className="mb-4 text-center text-lg font-medium text-gray-900">Message us on...</h4>
                
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
                  <span className="font-medium text-gray-900">Live Chat</span>
                </div>

                {/* Phone Button */}
                <div className="flex items-center gap-3 rounded-2xl border-2 p-4" style={{ borderColor: primaryColor }}>
                  <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: primaryColor }}>
                    <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                  </div>
                  <span className="font-medium text-gray-900">Phone</span>
                </div>

                  <p className="mt-4 text-center text-xs text-gray-400">
                    Powered by <span className="font-medium text-gray-600">ReceptionMate</span>
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}