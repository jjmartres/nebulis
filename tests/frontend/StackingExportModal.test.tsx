// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../../src/i18n';
import { ThemeProvider } from '../../src/hooks/useTheme';
import { GroupCard } from '../../src/components/observationDetail/StackingExportModal';
import type { StackingCalibration, StackingPlanGroup } from '../../src/lib/api/library';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const cal = (type: StackingCalibration['type'], name: string, over: Partial<StackingCalibration> = {}): StackingCalibration => ({
  type, name, scope: null, folderName: 'Darks', key: 'k', source: 'matched', fileCount: 30, bytes: 1,
  exposureSec: 180, gain: 200, binning: 1, sensorTempC: -10, filter: null, capturedAt: null, isExpired: false, ...over,
});

const group = (over: Partial<StackingPlanGroup> = {}): StackingPlanGroup => ({
  id: 'g', night: '2026-09-05', filter: 'H', exposureSec: 180, gain: 200, binning: 1, sensorTempC: -10,
  frames: 207, kept: 196, bytes: 1,
  dark: cal('dark', 'Darks_180s_Bin1_gain200_-10.2C', { deltaTempC: 0.2 }),
  flat: cal('flat', 'Flats_1.5s_Bin1_gain200_-10C', { fileCount: 40, deltaDays: 0, source: 'attached' }),
  flatDark: cal('flatDark', 'FlatDarks_1.5s_Bin1_gain200_-10C'),
  bias: null,
  issues: [],
  ...over,
});

const render = (g: StackingPlanGroup, includeNotKept = false) => renderToStaticMarkup(
  <ThemeProvider><GroupCard group={g} includeNotKept={includeNotKept} multiNight /></ThemeProvider>,
);

describe('StackingExportModal GroupCard', () => {
  it('shows the lights and each matched calibration set', () => {
    const html = render(group());
    for (const s of ['Sep', '>H<', '180s · gain 200 · bin 1 · -10 °C', '196 / 207 kept', 'Darks_180s_Bin1_gain200_-10.2C', '30 frames · Δ 0.2 °C', '40 frames · attached · same night']) {
      expect(html).toContain(s);
    }
    expect(html).toContain('Not needed: flat darks calibrate the flats');
  });

  it('spells out what is missing and what is doubtful', () => {
    const html = render(group({
      dark: null,
      flat: cal('flat', 'Flats_old', { deltaDays: 4 }),
      issues: [
        { code: 'dark_temp_far', severity: 'error', params: { bundle: 'Darks_180s_warm', delta: 6 } },
        { code: 'flat_other_night', severity: 'warning', params: { bundle: 'Flats_old', days: 4 } },
      ],
    }));
    expect(html).toContain('Nearest darks are 6 °C away (Darks_180s_warm)');
    expect(html).toContain('Shot 4 d from this night');
  });

  it('names the missing dark settings and counts every light when not-kept are included', () => {
    const html = render(group({ dark: null, issues: [{ code: 'no_dark', severity: 'error' }] }), true);
    expect(html).toContain('No darks at 180s, gain 200, bin 1');
    expect(html).toContain('207 lights');
  });
});
