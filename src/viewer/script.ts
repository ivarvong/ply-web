// No client script. Line targets use :target, and pack rows use the same.
// style-src stays 'self': Kumo's primary button would have needed inline styles.
export const VIEWER_CSP = `default-src 'none'; style-src 'self'; script-src 'none'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
