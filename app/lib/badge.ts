// Sets the native app-icon badge (iOS/Android) to `count`. Uses Capacitor's runtime plugin
// registry rather than a static import, so the web bundle needs no dependency and this is a
// clean no-op on web. In the native app, add a Badge plugin (registers as `Badge`), e.g.
// @capawesome/capacitor-badge, and it will pick this up automatically.
export async function setAppBadge(count: number): Promise<void> {
  try {
    const w = window as unknown as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        Plugins?: { Badge?: { set: (o: { count: number }) => Promise<void>; clear: () => Promise<void> } };
      };
    };
    if (!w?.Capacitor?.isNativePlatform?.()) return;
    const Badge = w.Capacitor?.Plugins?.Badge;
    if (!Badge) return;
    if (count > 0) await Badge.set({ count });
    else await Badge.clear();
  } catch {
    /* plugin missing / web: ignore */
  }
}

// Ask AppShell to re-fetch the unread counts now (e.g. right after marking a call viewed or
// opening a conversation), instead of waiting for the next poll.
export function refreshNotificationCounts(): void {
  try {
    window.dispatchEvent(new Event('counts:refresh'));
  } catch {
    /* SSR / no window: ignore */
  }
}
