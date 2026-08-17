/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  // Next 16 removed the `eslint` config key; linting is run separately
  // via `npm run lint`, so the build no longer needs to opt out of it.
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
      alias: {
        ...config.resolve?.alias,
        '@excalidraw/excalidraw$': path.resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/index.js'),
        '@excalidraw/excalidraw/index.css$': path.resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/index.css'),
      },
      aliasFields: ['browser'],
    };

    return config;
  },
};

module.exports = nextConfig;
