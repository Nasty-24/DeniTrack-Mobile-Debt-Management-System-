// Runs after the test framework loads. Screen checks wait up to 5 s: the first run after
// code changes is slow while Jest recompiles, which made 1 s waits flaky.
import { configure } from '@testing-library/react-native';

configure({ asyncUtilTimeout: 5000 });
