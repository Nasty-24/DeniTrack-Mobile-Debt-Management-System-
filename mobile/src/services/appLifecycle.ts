/**
 * Decides when to replay the launch screen after the app returns to the foreground.
 *
 * It is shown whenever the person comes back after leaving the app (Home, app switcher,
 * locking the phone) - but not when the app itself sent them out on purpose (share sheet,
 * PDF viewer, phone dialer), and not for sub-second interruptions.
 */
const MIN_AWAY_MS = 1000;
let externalPending = false;

/** Call just before opening something outside the app on purpose. */
export function expectExternalActivity(): void {
  externalPending = true;
}

/** Call when the app becomes active again; consumes any pending external activity. */
export function shouldShowSplashOnResume(awayMs: number): boolean {
  const cameBackFromOurOwnAction = externalPending;
  externalPending = false;
  return !cameBackFromOurOwnAction && awayMs >= MIN_AWAY_MS;
}
