import { expectExternalActivity, shouldShowSplashOnResume } from '../services/appLifecycle';

describe('splash on reopen', () => {
  it('shows the splash when the person comes back after leaving the app', () => {
    expect(shouldShowSplashOnResume(5_000)).toBe(true);
    expect(shouldShowSplashOnResume(60 * 60 * 1000)).toBe(true);
  });

  it('ignores sub-second interruptions such as the notification shade', () => {
    expect(shouldShowSplashOnResume(300)).toBe(false);
  });

  it('does not replay after something the app opened itself (share sheet, dialer, PDF)', () => {
    expectExternalActivity();
    expect(shouldShowSplashOnResume(20_000)).toBe(false);
    // only once: the next real return shows it again
    expect(shouldShowSplashOnResume(20_000)).toBe(true);
  });
});
