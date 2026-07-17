// Shared locale configuration — the single source of truth for which
// locales the app supports. Read by both the server-side resolver
// (request.ts) and the client-side switcher (language-switcher.tsx) so
// they can never drift out of sync.

export const SUPPORTED_LOCALES = ['en', 'pt-BR', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Cookie the user's language choice is persisted in (device-scoped —
 *  same pattern as the theme toggle's localStorage persistence, but a
 *  cookie so the server-rendered locale can read it too). */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'pt-BR': 'Português (BR)',
  es: 'Español',
};

export function isSupportedLocale(value: string | undefined | null): value is Locale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
