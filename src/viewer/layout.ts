// Named layout numbers shared by the stylesheet and the renderers. CSS media queries
// cannot read TypeScript, so styles.ts interpolates these into the sheet.

export const LAYOUT = Object.freeze({
  pageMaxRem: 52,
  phonePadPx: 16,
  desktopPadPx: 32,
  desktopMinPx: 960,
  stackMinPx: 720,
  headerPx: 48,
  controlPx: 32,
  compactControlPx: 26,
  controlRadiusPx: 8,
  inputFontPx: 14,
  compactFontPx: 13,
  bodyFontPx: 14,
  metaFontPx: 12,
  codeFontPx: 13,
  displayPhoneRem: 1.5,
  displayDesktopRem: 1.75,
  repoTitleRem: 1.25,
  subjectPx: 14,
  markPx: 8,
  markRadiusPx: 2,
  lineGutterRem: 3.5,
  percentSteps: 100,
  proseCh: 65,
  traceNameRem: 14,
  packBarPx: 28,
  swatchPx: 10,
  shortOid: 7,
  logSubjectChars: 120,
  commitMessageChars: 4_000,
  serverTimingChars: 1_800,
  msPerSecond: 1_000,
  cssCacheSeconds: 3_600,
  selectChevronPx: 12,
  targetGapPx: 8,
  primaryHoverOpacity: 0.88,
  focusRingPx: 1.5,
  packOffsetRem: 4.25,
  requestIdShown: 8,
  segSelectRem: 9.5,
  segInputRem: 8,
  segButtonRem: 3,
  segPopoverRem: 22,
  refSummaryRem: 8,
  protoLabelRem: 7,
})

export const RELATIVE_TIME = Object.freeze({
  justNowMs: 45_000,
  minuteMs: 60_000,
  hourMs: 3_600_000,
  dayMs: 86_400_000,
  monthDays: 30,
  yearDays: 365,
})

export const SPACE = Object.freeze({
  xs: '0.25rem',
  sm: '0.5rem',
  md: '0.75rem',
  lg: '1rem',
  xl: '1.5rem',
  xxl: '3rem',
})

export const RADIUS = Object.freeze({
  sm: '8px',
  md: '10px',
  lg: '12px',
  pill: '999px',
})
