import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale } from './config';

export default getRequestConfig(async () => {
  // The user's own choice (LanguageSwitcher) wins when present; falls
  // back to the deployment-wide default (env var), then 'en'. Reading
  // the cookie here — rather than only the env var — is what makes the
  // language switcher take effect without a full-app rebuild/redeploy.
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isSupportedLocale(cookieLocale)
    ? cookieLocale
    : process.env.NEXT_PUBLIC_APP_LOCALE || DEFAULT_LOCALE;

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages
  };
});
