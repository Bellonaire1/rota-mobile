module.exports = ({ config }) => {
  const profile = process.env.EAS_BUILD_PROFILE;
  const isDistributionBuild =
    profile === 'preview' ||
    profile === 'production' ||
    (process.env.EAS_BUILD === 'true' && profile !== 'development');

  if (isDistributionBuild) {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

    if (!apiUrl) {
      throw new Error(
        `[EAS Build Error] Refusing distribution build for profile "${profile}": ` +
          `EXPO_PUBLIC_API_URL is missing. An explicit public HTTPS API URL must be configured before producing an APK.`
      );
    }

    if (
      apiUrl.includes('YOUR_RENDER_SERVICE_NAME') ||
      apiUrl.includes('example.com') ||
      apiUrl.includes('<') ||
      apiUrl.includes('>')
    ) {
      throw new Error(
        `[EAS Build Error] Refusing distribution build: EXPO_PUBLIC_API_URL contains an unconfigured placeholder ("${apiUrl}"). ` +
          `Configure the actual public HTTPS endpoint before building.`
      );
    }

    if (!apiUrl.startsWith('https://')) {
      throw new Error(
        `[EAS Build Error] Refusing distribution build: EXPO_PUBLIC_API_URL must start with "https://". Got: "${apiUrl}"`
      );
    }

    if (
      apiUrl.includes('localhost') ||
      apiUrl.includes('127.0.0.1') ||
      apiUrl.includes('10.0.2.2') ||
      /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(apiUrl)
    ) {
      throw new Error(
        `[EAS Build Error] Refusing distribution build: EXPO_PUBLIC_API_URL targets a local or private network address ("${apiUrl}"). ` +
          `A publicly accessible HTTPS host is required.`
      );
    }
  }

  return {
    ...config,
  };
};
