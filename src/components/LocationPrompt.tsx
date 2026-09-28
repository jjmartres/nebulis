import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MapPin, CheckCircle2, AlertCircle } from 'lucide-react';
import { updateSettings } from '../lib/api/settings';

/** Empty-state prompt shown on Planner / Forecast when the observer location
 *  isn't set. Detects via the browser geolocation API and persists to app
 *  settings — so any page reading `settings.latitude/longitude` updates. */
export function LocationPrompt({
  isDark,
  isNight,
  isSpace,
  subText,
  description,
  invalidateKeys = [],
}: {
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  subText: string;
  description?: string;
  /** Extra query keys to invalidate after saving (page-specific data). */
  invalidateKeys?: readonly (readonly unknown[])[];
}) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'idle' | 'detecting' | 'saving' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const effectiveDescription = description ?? t('locationPrompt.defaultDescription');

  function handleDetect() {
    if (!navigator.geolocation) {
      setStatus('error');
      setErrorMsg(t('locationPrompt.geolocationUnsupported'));
      return;
    }
    // Geolocation only works on https:// or http://localhost. If the page was
    // opened over a LAN IP or .local hostname, the browser silently rejects
    // the request with POSITION_UNAVAILABLE, which is opaque without context.
    if (!window.isSecureContext) {
      setStatus('error');
      setErrorMsg(t('locationPrompt.insecureContext', { host: window.location.host }));
      return;
    }
    setStatus('detecting');
    setErrorMsg('');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Math.round(pos.coords.latitude * 10000) / 10000;
        const lon = Math.round(pos.coords.longitude * 10000) / 10000;
        setStatus('saving');
        try {
          // Writes through to the default observing site server-side (see
          // routes/settings.ts), so both legacy settings readers and the
          // sites-aware Planner/Forecast pages need invalidating.
          await updateSettings({ latitude: lat, longitude: lon });
          await queryClient.invalidateQueries({ queryKey: ['settings'] });
          await queryClient.invalidateQueries({ queryKey: ['sites'] });
          await queryClient.invalidateQueries({ queryKey: ['active-site'] });
          // Always invalidate forecast and planner so both pages update when location changes
          await queryClient.invalidateQueries({ queryKey: ['forecast'] });
          await queryClient.invalidateQueries({ queryKey: ['planner-tonight'] });
          for (const key of invalidateKeys) {
            await queryClient.invalidateQueries({ queryKey: key });
          }
          setStatus('success');
        } catch (e) {
          setStatus('error');
          setErrorMsg(e instanceof Error ? e.message : t('locationPrompt.saveFailed'));
        }
      },
      (err) => {
        setStatus('error');
        const isMac = /Mac/i.test(navigator.platform);
        setErrorMsg(
          err.code === 1
            ? t('locationPrompt.accessDenied')
            : err.code === 2
              ? isMac
                ? t('locationPrompt.unavailableMac')
                : t('locationPrompt.unavailableOther')
              : t('locationPrompt.timedOut'),
        );
      },
      { timeout: 15000, maximumAge: 300000, enableHighAccuracy: false },
    );
  }

  const detecting = status === 'detecting' || status === 'saving';

  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
      <MapPin className={`w-12 h-12 ${subText}`} />
      <h2 className={`text-xl font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>{t('locationPrompt.title')}</h2>
      <p className={`max-w-md ${subText}`}>
        {effectiveDescription}
      </p>
      <button
        type="button"
        onClick={handleDetect}
        disabled={detecting}
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 ${
          isNight ? 'bg-red-950/40 text-red-400 hover:bg-red-950/60'
            : isSpace ? 'bg-violet-900/30 text-violet-300 hover:bg-violet-900/50'
              : 'bg-accent-600 text-white hover:bg-accent-700'
        }`}
      >
        <MapPin className="w-4 h-4" />
        {status === 'detecting' ? t('locationPrompt.detecting')
          : status === 'saving' ? t('locationPrompt.saving')
            : t('locationPrompt.useCurrentLocation')}
      </button>
      {status === 'success' && (
        <span className="text-sm text-emerald-500 flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4" /> {t('locationPrompt.locationSaved')}
        </span>
      )}
      {status === 'error' && (
        <span className="text-sm text-red-400 flex items-center gap-1.5 max-w-md">
          <AlertCircle className="w-4 h-4 shrink-0" /> {errorMsg}
        </span>
      )}
      <Link to="/settings" className={`text-xs ${subText} hover:underline`}>
        {t('locationPrompt.setManuallyLink')}
      </Link>
    </div>
  );
}
