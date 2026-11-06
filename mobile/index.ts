import { registerRootComponent } from 'expo';

import App from './App';
import { defineBackgroundTasks } from './src/services/backgroundSync';

// Background work (M-Pesa SMS matching, reminder SMS) must be defined before the app starts.
defineBackgroundTasks();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
