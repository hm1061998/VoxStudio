import { useEffect } from 'react';
import { useLocation } from 'react-router';
import type { MessageKey } from '../i18n/en';
import { useI18n } from '../i18n';
import { useAuth } from './auth';

const TITLES: [prefix: string, key: MessageKey][] = [
  ['/login', 'auth.signIn'],
  ['/register', 'auth.createAccount'],
  ['/reset', 'auth.resetTitle'],
  ['/voices', 'nav.voices'],
  ['/presets', 'nav.presets'],
  ['/pronunciation', 'nav.pronunciation'],
  ['/renders', 'nav.renders'],
  ['/settings', 'nav.settings'],
  ['/admin', 'nav.admin'],
  ['/projects', 'nav.projects'],
];

function setMeta(name: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

/**
 * Keeps the tab title and the robots hint in step with the page. The app is behind a sign-in, so once someone is
 * signed in every page asks not to be indexed; only the public sign-in and registration pages are indexable.
 */
export function RouteMeta() {
  const { pathname } = useLocation();
  const { t, lang } = useI18n();
  const { user } = useAuth();
  useEffect(() => {
    const hit = TITLES.find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
    const home = t('seo.title');
    document.title = hit ? `${t(hit[1])} · VoxStudio` : home;
    setMeta('description', t('seo.description'));
    setMeta('robots', user ? 'noindex, nofollow' : 'index, follow');
  }, [pathname, lang, user, t]);
  return null;
}
