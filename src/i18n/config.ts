// Agent OS fork: Hungarian added and made the default (messages/hu.json).
export const locales = ['hu', 'en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar'] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = 'hu'
export const localeNames: Record<Locale, string> = {
  hu: 'Magyar',
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية',
}
