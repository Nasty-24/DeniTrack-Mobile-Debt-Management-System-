// Adds build-time settings on top of app.json.
// Cleartext HTTP is allowed only for local development backends (http://...);
// release builds must point EXPO_PUBLIC_API_URL at an https:// server.
module.exports = ({ config }) => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8000';
  const allowCleartext = apiUrl.startsWith('http://');
  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      ['expo-build-properties', { android: { usesCleartextTraffic: allowCleartext } }],
    ],
    extra: { ...(config.extra ?? {}), apiUrl },
  };
};
