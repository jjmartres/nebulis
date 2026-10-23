/**
 * Human text for an alert, in the language chosen in the alert options.
 *
 * The server has no i18n framework (the web client's locale files are bundled
 * into the SPA), and alerts are a handful of short sentences, so the strings
 * live here, one table per language. Every table has the same keys; the
 * parity test in tests/backend/alertMessages.test.ts keeps it that way.
 */
import type { AlertEvent, AlertLanguage, ClearNightAlertData, ImportAlertData } from './types.js';

export interface AlertMessage {
  title: string;
  body: string;
  /** Short tags for ntfy (rendered as emoji or labels there). */
  tags: string[];
  /** A link worth opening, when there is one. */
  url: string | null;
}

type Vars = Record<string, string | number>;

const STRINGS = {
  en: {
    importFinishedTitle: 'Import finished',
    importFinishedBody: '{count} new files from {origin}: {objects}',
    importFinishedNoObjects: '{count} new files from {origin}',
    importFailedTitle: 'Import failed',
    importFailedBody: '{origin}: {error}',
    originFolder: 'a local folder',
    originTelescope: 'the telescope',
    more: '+{count} more',
    clearTitle: 'Clear night ahead at {site}',
    clearHours: '{clear} clear out of {dark} of darkness (clouds up to {pct}%), best from {start} to {end}',
    clearMoon: 'Moon {illum}%, below the horizon for {down} of the clear hours',
    clearMoonUp: 'Moon {illum}%, up for all the clear hours',
    clearSeeing: 'Seeing: {label}',
    seeing1: 'excellent', seeing2: 'good', seeing3: 'average', seeing4: 'poor', seeing5: 'bad',
    updateTitle: 'Nebulis {version} is available',
    updateBody: 'You are running {current}.',
    testTitle: 'Nebulis test alert',
    testBody: 'If you can read this, alerts to this channel work.',
    decimal: '.',
  },
  fr: {
    importFinishedTitle: 'Import terminé',
    importFinishedBody: '{count} nouveaux fichiers depuis {origin} : {objects}',
    importFinishedNoObjects: '{count} nouveaux fichiers depuis {origin}',
    importFailedTitle: "Échec de l'import",
    importFailedBody: '{origin} : {error}',
    originFolder: 'un dossier local',
    originTelescope: 'le télescope',
    more: 'et {count} autres',
    clearTitle: 'Nuit dégagée prévue à {site}',
    clearHours: '{clear} dégagées sur {dark} de nuit noire (nuages jusqu’à {pct} %), meilleur créneau de {start} à {end}',
    clearMoon: 'Lune à {illum} %, sous l’horizon pendant {down} des heures dégagées',
    clearMoonUp: 'Lune à {illum} %, levée pendant toutes les heures dégagées',
    clearSeeing: 'Seeing : {label}',
    seeing1: 'excellent', seeing2: 'bon', seeing3: 'moyen', seeing4: 'médiocre', seeing5: 'mauvais',
    updateTitle: 'Nebulis {version} est disponible',
    updateBody: 'Version installée : {current}.',
    testTitle: 'Alerte de test Nebulis',
    testBody: 'Si vous lisez ceci, les alertes vers ce canal fonctionnent.',
    decimal: ',',
  },
  de: {
    importFinishedTitle: 'Import abgeschlossen',
    importFinishedBody: '{count} neue Dateien von {origin}: {objects}',
    importFinishedNoObjects: '{count} neue Dateien von {origin}',
    importFailedTitle: 'Import fehlgeschlagen',
    importFailedBody: '{origin}: {error}',
    originFolder: 'einem lokalen Ordner',
    originTelescope: 'dem Teleskop',
    more: '+{count} weitere',
    clearTitle: 'Klare Nacht in {site}',
    clearHours: '{clear} klar von {dark} Dunkelheit (Bewölkung bis {pct} %), am besten von {start} bis {end}',
    clearMoon: 'Mond {illum} %, unter dem Horizont für {down} der klaren Stunden',
    clearMoonUp: 'Mond {illum} %, während aller klaren Stunden über dem Horizont',
    clearSeeing: 'Seeing: {label}',
    seeing1: 'ausgezeichnet', seeing2: 'gut', seeing3: 'mittel', seeing4: 'schlecht', seeing5: 'sehr schlecht',
    updateTitle: 'Nebulis {version} ist verfügbar',
    updateBody: 'Installiert ist {current}.',
    testTitle: 'Nebulis-Testalarm',
    testBody: 'Wenn Sie dies lesen, funktionieren Alarme an diesen Kanal.',
    decimal: ',',
  },
  es: {
    importFinishedTitle: 'Importación terminada',
    importFinishedBody: '{count} archivos nuevos desde {origin}: {objects}',
    importFinishedNoObjects: '{count} archivos nuevos desde {origin}',
    importFailedTitle: 'La importación falló',
    importFailedBody: '{origin}: {error}',
    originFolder: 'una carpeta local',
    originTelescope: 'el telescopio',
    more: 'y {count} más',
    clearTitle: 'Noche despejada en {site}',
    clearHours: '{clear} despejadas de {dark} de oscuridad (nubes hasta {pct} %), mejor de {start} a {end}',
    clearMoon: 'Luna al {illum} %, bajo el horizonte durante {down} de las horas despejadas',
    clearMoonUp: 'Luna al {illum} %, sobre el horizonte durante todas las horas despejadas',
    clearSeeing: 'Seeing: {label}',
    seeing1: 'excelente', seeing2: 'bueno', seeing3: 'medio', seeing4: 'malo', seeing5: 'muy malo',
    updateTitle: 'Nebulis {version} está disponible',
    updateBody: 'Versión instalada: {current}.',
    testTitle: 'Alerta de prueba de Nebulis',
    testBody: 'Si puede leer esto, las alertas a este canal funcionan.',
    decimal: ',',
  },
  nl: {
    importFinishedTitle: 'Import voltooid',
    importFinishedBody: '{count} nieuwe bestanden van {origin}: {objects}',
    importFinishedNoObjects: '{count} nieuwe bestanden van {origin}',
    importFailedTitle: 'Import mislukt',
    importFailedBody: '{origin}: {error}',
    originFolder: 'een lokale map',
    originTelescope: 'de telescoop',
    more: '+{count} meer',
    clearTitle: 'Heldere nacht in {site}',
    clearHours: '{clear} helder van {dark} duisternis (bewolking tot {pct}%), het best van {start} tot {end}',
    clearMoon: 'Maan {illum}%, onder de horizon gedurende {down} van de heldere uren',
    clearMoonUp: 'Maan {illum}%, boven de horizon gedurende alle heldere uren',
    clearSeeing: 'Seeing: {label}',
    seeing1: 'uitstekend', seeing2: 'goed', seeing3: 'gemiddeld', seeing4: 'slecht', seeing5: 'zeer slecht',
    updateTitle: 'Nebulis {version} is beschikbaar',
    updateBody: 'Geïnstalleerd: {current}.',
    testTitle: 'Nebulis-testmelding',
    testBody: 'Als je dit leest, werken meldingen naar dit kanaal.',
    decimal: ',',
  },
} satisfies Record<AlertLanguage, Record<string, string>>;

export type AlertStringKey = keyof (typeof STRINGS)['en'];
export const _alertStringsForTests = STRINGS;

function fill(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** "5 h", "4.5 h" / "4,5 h". */
export function formatHours(hours: number, lang: AlertLanguage): string {
  const rounded = Math.round(hours * 2) / 2;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace('.', STRINGS[lang].decimal);
  return `${text} h`;
}

/** 24-hour local time, the same for every language: "22:30". */
export function formatClock(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

const MAX_LISTED_OBJECTS = 5;

function importOrigin(d: ImportAlertData, s: (typeof STRINGS)[AlertLanguage]): string {
  if (d.source === 'folder') return s.originFolder;
  return d.telescopeName ?? s.originTelescope;
}

function objectList(d: ImportAlertData, s: (typeof STRINGS)[AlertLanguage]): string {
  const names = d.objects.map(o => o.name);
  const shown = names.slice(0, MAX_LISTED_OBJECTS).join(', ');
  const rest = names.length - MAX_LISTED_OBJECTS;
  return rest > 0 ? `${shown} ${fill(s.more, { count: rest })}` : shown;
}

function clearNightBody(d: ClearNightAlertData, lang: AlertLanguage): string {
  const s = STRINGS[lang];
  const lines = [
    fill(s.clearHours, {
      clear: formatHours(d.clearHours, lang),
      dark: formatHours(d.darkHours, lang),
      pct: d.maxCloudCover,
      start: formatClock(d.longestStart, d.timeZone),
      end: formatClock(d.longestEnd, d.timeZone),
    }),
    d.moonDownHours > 0
      ? fill(s.clearMoon, { illum: d.moonIllumination, down: formatHours(d.moonDownHours, lang) })
      : fill(s.clearMoonUp, { illum: d.moonIllumination }),
  ];
  if (d.seeing !== null) {
    const key = `seeing${Math.min(5, Math.max(1, Math.round(d.seeing)))}` as AlertStringKey;
    lines.push(fill(s.clearSeeing, { label: s[key] }));
  }
  return lines.join('\n');
}

export function formatAlert(event: AlertEvent, lang: AlertLanguage): AlertMessage {
  const s = STRINGS[lang];
  switch (event.type) {
    case 'import.finished': {
      const d = event.data;
      const vars = { count: d.newFiles, origin: importOrigin(d, s), objects: objectList(d, s) };
      return {
        title: s.importFinishedTitle,
        body: fill(d.objects.length > 0 ? s.importFinishedBody : s.importFinishedNoObjects, vars),
        tags: ['inbox_tray'],
        url: null,
      };
    }
    case 'import.failed':
      return {
        title: s.importFailedTitle,
        body: fill(s.importFailedBody, { origin: importOrigin(event.data, s), error: event.data.error ?? '?' }),
        tags: ['warning'],
        url: null,
      };
    case 'night.clear':
      return {
        title: fill(s.clearTitle, { site: event.data.siteName }),
        body: clearNightBody(event.data, lang),
        tags: ['milky_way'],
        url: null,
      };
    case 'update.available':
      return {
        title: fill(s.updateTitle, { version: event.data.latestVersion }),
        body: fill(s.updateBody, { current: event.data.currentVersion }),
        tags: ['arrow_up'],
        url: event.data.notesUrl,
      };
    case 'test':
      return { title: s.testTitle, body: s.testBody, tags: ['bell'], url: null };
  }
}
