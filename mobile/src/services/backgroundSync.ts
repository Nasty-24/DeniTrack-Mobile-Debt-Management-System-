/**
 * Lets Android run the phone's SMS work (M-Pesa matching, reminder SMS) while the app is
 * closed. Android decides exactly when, roughly every 15 minutes or more; the work also
 * runs whenever the app is opened.
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { getPhoneSmsPrefs, runPhoneTasksFromStorage, smsAvailable } from './phoneSms';

export const PHONE_TASK = 'denitrack.phone-sms';

/** Must run at start-up outside React (index.ts), so the task exists when Android wakes the app. */
export function defineBackgroundTasks(): void {
  if (!smsAvailable) return;
  TaskManager.defineTask(PHONE_TASK, async () => {
    try {
      await runPhoneTasksFromStorage();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

/** Registers the task when this phone has M-Pesa reading or reminder sending switched on. */
export async function updateBackgroundTask(): Promise<void> {
  if (!smsAvailable) return;
  const prefs = await getPhoneSmsPrefs();
  const wanted = prefs.readMpesa || prefs.sendReminders;
  const registered = await TaskManager.isTaskRegisteredAsync(PHONE_TASK);
  if (wanted && !registered) await BackgroundTask.registerTaskAsync(PHONE_TASK, { minimumInterval: 15 });
  else if (!wanted && registered) await BackgroundTask.unregisterTaskAsync(PHONE_TASK);
}
