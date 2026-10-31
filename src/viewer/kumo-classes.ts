// Class strings taken from @cloudflare/kumo 2.16.0 component variants
// (button secondary/sm, input base, badge, banner). They only do anything
// because /view.css serves kumo-standalone.css. Kumo's primary button also
// sets inline --kumo-button-emphasis-* styles; style-src 'self' would drop
// those, so the primary action uses the contrast and inverse tokens instead.
// hover:opacity-* is not in the standalone sheet; .is-primary:hover lives in styles.ts.

export const KUMO_BUTTON_FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand cursor-pointer'

export const KUMO_BUTTON_SECONDARY = 'bg-kumo-base text-kumo-default ring ring-kumo-line hover:bg-kumo-tint shadow-xs border-0'

export const KUMO_BUTTON_SIZE_SM = 'h-6.5 gap-1 rounded-md px-2 text-xs font-medium inline-flex items-center justify-center whitespace-nowrap select-none'

export const KUMO_BUTTON_SIZE_BASE = 'h-9 gap-1.5 rounded-lg px-3 font-medium inline-flex items-center justify-center whitespace-nowrap select-none'

export const KUMO_BUTTON_PRIMARY = 'bg-kumo-contrast text-kumo-inverse shadow-xs border-0'

export const KUMO_INPUT = 'border-0 bg-kumo-control text-kumo-default ring ring-kumo-line outline-none focus:outline-none kumo-input-placeholder focus:ring-[1.5px] focus:ring-kumo-focus/50 h-9 rounded-lg px-3 font-sans'

// Kumo Input size "sm": h-6.5, rounded-md, px-2, text-xs, plus the default ring variant.
export const KUMO_INPUT_SM = 'border-0 bg-kumo-control text-kumo-default ring ring-kumo-line outline-none focus:outline-none kumo-input-placeholder focus:ring-[1.5px] focus:ring-kumo-focus/50 h-6.5 rounded-md px-2 text-xs font-sans'

export const KUMO_BADGE = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-kumo-fill text-kumo-badge-neutral-subtle'

export const KUMO_BADGE_ORANGE = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-kumo-badge-orange text-black'

export const KUMO_BADGE_SUCCESS = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-kumo-success-tint text-kumo-success'

export const KUMO_BANNER_ERROR = 'flex items-start gap-3 rounded-lg px-4 py-3 text-sm bg-kumo-danger-tint text-kumo-danger'

export const KUMO_BANNER_ALERT = 'flex items-start gap-3 rounded-lg px-4 py-3 text-sm bg-kumo-warning-tint text-kumo-warning'

export const KUMO_BANNER_INFO = 'flex items-start gap-3 rounded-lg px-4 py-3 text-sm bg-kumo-info-tint text-kumo-info'

export const KUMO_SURFACE = 'bg-kumo-base border border-kumo-line rounded-xl shadow-xs'

export const KUMO_LINK = 'text-kumo-link'

export type BannerTone = 'error' | 'alert' | 'info'

export function bannerClass(tone: BannerTone): string {
  if (tone === 'error') return KUMO_BANNER_ERROR
  if (tone === 'alert') return KUMO_BANNER_ALERT
  return KUMO_BANNER_INFO
}

export type ButtonVariant = 'primary' | 'secondary'
export type ButtonSize = 'sm' | 'base'

export function buttonClass(variant: ButtonVariant, size: ButtonSize): string {
  const sizeClass = size === 'sm' ? KUMO_BUTTON_SIZE_SM : KUMO_BUTTON_SIZE_BASE
  const variantClass = variant === 'primary' ? KUMO_BUTTON_PRIMARY : KUMO_BUTTON_SECONDARY
  return `${sizeClass} ${variantClass} ${KUMO_BUTTON_FOCUS}`
}

// LayerCard (kumo 2.16.0, layer-card.tsx): an elevated frame, a Secondary header strip, and a raised Primary panel.
// Primary drops its p-4 pr-3 here (rows and code bring their own padding); everything else is verbatim.
export const KUMO_LAYER_CARD = 'flex w-full flex-col overflow-hidden rounded-lg bg-kumo-elevated text-base ring ring-kumo-hairline'
export const KUMO_LAYER_CARD_SECONDARY = 'flex items-center gap-2 bg-kumo-elevated text-base font-medium text-kumo-subtle'
export const KUMO_LAYER_CARD_PRIMARY = 'relative flex flex-col overflow-hidden rounded-lg bg-kumo-base text-inherit no-underline ring ring-kumo-fill'

// Breadcrumbs size "sm" and its parts (breadcrumbs.tsx).
export const KUMO_BREADCRUMBS = 'flex min-w-0 grow items-center overflow-hidden whitespace-nowrap text-sm gap-0.5'
export const KUMO_BREADCRUMB_LINK = 'flex shrink-0 items-center gap-1 whitespace-nowrap text-kumo-subtle no-underline'
export const KUMO_BREADCRUMB_CURRENT = 'flex max-w-full min-w-0 items-center gap-1 font-medium'
export const KUMO_BREADCRUMB_SEPARATOR = 'flex shrink-0 items-center text-kumo-inactive'

// Badge base + variants (badge.tsx).
const KUMO_BADGE_BASE = 'inline-flex w-fit flex-none shrink-0 items-center justify-self-start gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap'
export const KUMO_BADGE_NEUTRAL = `${KUMO_BADGE_BASE} bg-kumo-fill text-kumo-badge-neutral-subtle`
export const KUMO_BADGE_OUTLINE = `${KUMO_BADGE_BASE} border border-kumo-fill bg-kumo-base text-kumo-default`
export const KUMO_BADGE_INFO = `${KUMO_BADGE_BASE} bg-kumo-info-tint text-kumo-info`
export const KUMO_BADGE_WARNING = `${KUMO_BADGE_BASE} bg-kumo-warning-tint text-kumo-warning`
export const KUMO_BADGE_DANGER = `${KUMO_BADGE_BASE} bg-kumo-danger-tint text-kumo-danger`

// Button variant "ghost" (button.tsx), for quiet actions such as Raw and the ref switcher.
export const KUMO_BUTTON_GHOST = 'bg-transparent text-kumo-default hover:bg-kumo-tint shadow-none border-0'

// Text variants (text.tsx).
export const KUMO_TEXT_HEADING2 = 'text-2xl font-semibold'
export const KUMO_TEXT_HEADING3 = 'text-lg font-semibold'
export const KUMO_TEXT_SECONDARY = 'text-kumo-subtle'
export const KUMO_TEXT_MONO_SECONDARY = 'font-mono text-kumo-subtle'

// Code block (code.tsx).
export const KUMO_CODE_BLOCK = 'min-w-0 rounded-md border border-kumo-fill bg-kumo-base'
