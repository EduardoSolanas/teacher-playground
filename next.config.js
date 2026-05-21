/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config, { isServer }) => {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        ...(Array.isArray(config.watchOptions?.ignored) ? config.watchOptions.ignored : []),
        '**/.data/**',
      ],
    };

    // Excalidraw requires JSON module support
    config.resolve = {
      ...config.resolve,
      aliasFields: ['browser'],
    };

    return config;
  },
};

module.exports = nextConfig;
