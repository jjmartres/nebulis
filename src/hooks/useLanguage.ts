/**
 * Thin wrapper over the i18next singleton (src/i18n.ts), in the same shape as
 * useTheme.ts: a lazily-initialized value, a setter, and an effect that keeps
 * a document attribute in sync. Persistence and browser-language detection
 * are handled by i18next-browser-languagedetector, not hand-rolled here —
 * unlike theme, which predates i18next and does it manually.
 */
import { useCallback, useEffect, useState } from 'react';
import i18n, { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n';

function isSupportedLanguage(code: string): code is SupportedLanguage {
  return SUPPORTED_LANGUAGES.some(l => l.code === code);
}

/** i18next resolves a detected/stored tag like 'en-US' to a base ('en')
 *  internally, but `i18n.language` can still surface the untrimmed tag.
 *  Normalize here too so a stored 'de-DE' matches our 'de' resource key. */
function resolveLanguage(code: string): SupportedLanguage {
  if (isSupportedLanguage(code)) return code;
  const base = code.split('-')[0];
  return isSupportedLanguage(base) ? base : 'en';
}

export function useLanguage() {
  const [language, setLanguageState] = useState<SupportedLanguage>(() => resolveLanguage(i18n.language));

  useEffect(() => {
    const handleChange = (lng: string) => setLanguageState(resolveLanguage(lng));
    i18n.on('languageChanged', handleChange);
    return () => { i18n.off('languageChanged', handleChange); };
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((code: SupportedLanguage) => {
    void i18n.changeLanguage(code);
  }, []);

  return { language, setLanguage, languages: SUPPORTED_LANGUAGES };
}
