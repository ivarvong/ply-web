// Class strings taken from @cloudflare/kumo 2.15.0 component variants
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
