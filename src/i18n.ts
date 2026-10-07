// Tiny i18n: flat dictionaries, {placeholders}, data-i18n attributes in the markup.
import en from './locales/en.json';
import ru from './locales/ru.json';

type Dict = Record<string, string>;
const dicts: Record<string, Dict> = { en, ru };
export const languageNames: Record<string, string> = { en: 'English', ru: 'Русский' };
export const languages = Object.keys(dicts);
const listeners = new Set<(lang: string) => void>();
let lang = pickLang();

function pickLang(): string {
  const saved = localStorage.getItem('lang');
  if (saved && dicts[saved]) return saved;
  const wanted = (navigator.languages ?? [navigator.language]).map((l) => l.slice(0, 2));
  return wanted.find((l) => dicts[l]) ?? 'en';
}

export const currentLang = () => lang;

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const s = dicts[lang][key] ?? dicts.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function setLang(next: string): void {
  if (!dicts[next]) return;
  lang = next;
  localStorage.setItem('lang', next);
  apply();
  listeners.forEach((fn) => fn(next));
}

export const onLangChange = (fn: (lang: string) => void) => listeners.add(fn);

export function apply(): void {
  document.documentElement.lang = lang;
  document.title = t('meta.title');
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n!)));
  document.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml!)));
  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder!)));
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle!)));
  const select = document.getElementById('lang') as HTMLSelectElement | null;
  if (select) select.value = lang;
}
