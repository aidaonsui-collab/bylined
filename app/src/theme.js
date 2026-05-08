// Bylined design tokens. Mirrors the marketing site's CSS variables in
// a JS-friendly form for inline-style components. When the marketing
// styles.css is loaded, the CSS variables also work — pick whichever
// suits the component (CSS vars for static styling, theme.js objects
// for dynamic / computed styles).

export const palette = {
  // Dark mode (default)
  bg: '#08080A',
  surface: '#131318',
  surface2: '#1A1A20',
  surface3: '#22222A',
  border: '#2A2A33',
  border2: '#3A3A46',
  borderStrong: '#4A4A56',
  fg: '#F2F2F3',
  fgMuted: '#A8A8B0',
  fgSubtle: '#75757F',
  fgFaint: '#4A4A52',

  accent: '#D4FF3F',
  accentOn: '#0A0A0B',
  accentGlow: 'rgba(212, 255, 63, 0.18)',
  accentFaint: 'rgba(212, 255, 63, 0.10)',
  accentRing: 'rgba(212, 255, 63, 0.45)',
  accentText: '#D4FF3F',

  success: '#5BD898',
  warn: '#F5C842',
  danger: '#FF6363',
  info: '#6DA8FF',

  lift: 'rgba(255,255,255,0.045)',
  liftStrong: 'rgba(255,255,255,0.08)',
};

export const lightPalette = {
  ...palette,
  bg: '#F4F1E8',
  surface: '#FCFAF4',
  surface2: '#EFEADC',
  surface3: '#E2DCC9',
  border: '#D2CBB6',
  border2: '#B8B097',
  borderStrong: '#908566',
  fg: '#1A1815',
  fgMuted: '#5C5648',
  fgSubtle: '#847B66',
  fgFaint: '#B0A893',
  accentText: '#4A6300',
  accentGlow: 'rgba(74, 99, 0, 0.28)',
  accentFaint: 'rgba(74, 99, 0, 0.13)',
  accentRing: 'rgba(74, 99, 0, 0.5)',
  lift: 'rgba(255,255,255,0.7)',
  liftStrong: 'rgba(255,255,255,0.95)',
};

export const type = {
  sans: '"General Sans", "Inter Tight", -apple-system, system-ui, sans-serif',
  serif: '"Instrument Serif", "Cormorant Garamond", Georgia, serif',
  mono: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, "SF Mono", monospace',
};

// Shadows — match the marketing site's depth recipes.
export const shadows = (p) => ({
  card: `0 1px 0 0 ${p.lift} inset, 0 1px 2px rgba(0,0,0,0.3)`,
  pop: `0 1px 0 0 ${p.liftStrong} inset, 0 12px 32px -16px rgba(0,0,0,0.55), 0 0 0 1px ${p.border}`,
  primaryBtn: `0 1px 0 0 rgba(255,255,255,0.4) inset, 0 0 0 1px color-mix(in oklab, ${p.accent} 60%, black), 0 6px 16px -6px ${p.accentGlow}`,
});
