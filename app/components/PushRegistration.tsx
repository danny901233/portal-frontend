'use client';

// Registers the device for iOS push notifications when the portal is running
// inside the ReceptionMate Capacitor app. On the plain web (browser) this is a
// no-op — `window.Capacitor` only exists inside the native shell.
//
// Because the app is a thin server.url wrapper (no local JS bundle), we talk to
// the native @capacitor/push-notifications plugin through the injected bridge at
// window.Capacitor.Plugins.PushNotifications rather than importing the npm pkg.

import { useEffect } from 'react';
import { getSessionToken } from '../lib/auth';
import { registerDeviceToken } from '../lib/api';

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    PushNotifications?: {
      checkPermissions: () => Promise<{ receive: string }>;
      requestPermissions: () => Promise<{ receive: string }>;
      register: () => Promise<void>;
      addListener: (
        event: string,
        cb: (data: { value?: string; error?: string }) => void,
      ) => Promise<{ remove: () => void }> | { remove: () => void };
      removeAllListeners?: () => Promise<void>;
    };
  };
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge;
  }
}

export default function PushRegistration() {
  useEffect(() => {
    const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
    if (!cap?.isNativePlatform?.()) return; // web browser — nothing to do
    const Push = cap.Plugins?.PushNotifications;
    if (!Push) return; // plugin not installed in this build
    // Only register once the user is authenticated (token needs a user to attach to).
    if (!getSessionToken()) return;

    let cancelled = false;
    const removers: Array<() => void> = [];

    const addListener = async (
      event: string,
      cb: (data: { value?: string; error?: string }) => void,
    ) => {
      try {
        const handle = await Push.addListener(event, cb);
        if (handle && typeof handle.remove === 'function') removers.push(handle.remove);
      } catch {
        /* ignore */
      }
    };

    (async () => {
      try {
        let perm = await Push.checkPermissions();
        if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
          perm = await Push.requestPermissions();
        }
        if (cancelled || perm.receive !== 'granted') return;

        // Fires with the APNs device token once iOS returns it.
        await addListener('registration', (data) => {
          const token = data?.value;
          if (token) void registerDeviceToken(token).catch(() => {});
        });
        await addListener('registrationError', (data) => {
          console.warn('[PUSH] registration error', data?.error);
        });

        await Push.register();
      } catch (err) {
        console.warn('[PUSH] setup failed', err);
      }
    })();

    return () => {
      cancelled = true;
      removers.forEach((r) => {
        try {
          r();
        } catch {
          /* ignore */
        }
      });
    };
  }, []);

  return null;
}
