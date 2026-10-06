/** How often a linked folder can refresh itself, in minutes. Mirrors REFRESH_INTERVALS_MIN in
 *  server/lib/library/librarySources.ts. `labelKey` resolves in the `library` namespace. */
export const REFRESH_CHOICES = [
  { minutes: 60, labelKey: 'linkFolderWizard.refreshEveryHour' },
  { minutes: 360, labelKey: 'linkFolderWizard.refreshEverySixHours' },
  { minutes: 1440, labelKey: 'linkFolderWizard.refreshDaily' },
  { minutes: 10080, labelKey: 'linkFolderWizard.refreshWeekly' },
] as const;

/** What "ongoing" starts on: most people add a night's data at a time. */
export const DEFAULT_REFRESH_MINUTES = 1440;
