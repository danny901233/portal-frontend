'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useLang } from '@/app/i18n/LocaleProvider';

type ToastVariant = 'success' | 'error' | 'info' | 'warning';

type Toast = {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  duration: number;
};

type ToastInput = Omit<Toast, 'id' | 'duration'> & {
  duration?: number;
};

type ToastContextValue = {
  show: (input: ToastInput) => string;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  warning: (title: string, description?: string) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const variantStyles: Record<ToastVariant, { border: string; icon: ReactNode }> = {
  success: { border: 'border-emerald-500/40', icon: <CheckCircle2 className="h-4 w-4 text-emerald-300" /> },
  error: { border: 'border-rose-500/40', icon: <XCircle className="h-4 w-4 text-rose-300" /> },
  info: { border: 'border-sky-500/40', icon: <Info className="h-4 w-4 text-sky-300" /> },
  warning: { border: 'border-amber-500/40', icon: <AlertTriangle className="h-4 w-4 text-amber-300" /> },
};

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `toast-${Math.random().toString(36).slice(2)}-${Date.now()}`;

export function ToastProvider({ children }: { children: ReactNode }) {
  const lang = useLang();
  const c = {
    en: { dismiss: 'Dismiss notification' },
    fr: { dismiss: 'Fermer la notification' },
  }[lang];
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (timers.current[id]) {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      const id = newId();
      const duration = input.duration ?? 4500;
      const toast: Toast = {
        id,
        title: input.title,
        description: input.description,
        variant: input.variant,
        duration,
      };
      setToasts((prev) => [...prev, toast]);
      if (duration > 0) {
        timers.current[id] = setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const currentTimers = timers.current;
    return () => {
      Object.values(currentTimers).forEach(clearTimeout);
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      dismiss,
      success: (title, description) => show({ title, description, variant: 'success' }),
      error: (title, description) => show({ title, description, variant: 'error', duration: 6000 }),
      info: (title, description) => show({ title, description, variant: 'info' }),
      warning: (title, description) => show({ title, description, variant: 'warning' }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-full max-w-sm flex-col gap-2"
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map((toast) => {
          const styles = variantStyles[toast.variant];
          return (
            <div
              key={toast.id}
              className={`rm-toast pointer-events-auto rounded-xl border ${styles.border} bg-slate-900/90 p-3 text-slate-100 shadow-lg shadow-black/40 backdrop-blur`}
              role="status"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0">{styles.icon}</div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-tight">{toast.title}</p>
                  {toast.description && (
                    <p className="mt-0.5 text-xs text-slate-400">{toast.description}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
                  aria-label={c.dismiss}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}