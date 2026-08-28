/** @type {import('next').NextConfig} */
const path = require('path');
const fs = require('fs');

/**
 * The client needs the guest hostname at build time (Next inlines
 * NEXT_PUBLIC_*), while the Worker needs it at runtime. Reading the single
 * value out of wrangler.toml keeps them from drifting: a mismatch would leave
 * the guest page served but the prompt never rendered, which is invisible
 * until a real student fails to join. An explicit env var still wins so the
 * e2e harness can point at join.localhost.
 */
function guestHostnameFromWranglerConfig() {
  try {
    const toml = fs.readFileSync(path.join(__dirname, 'wrangler.toml'), 'utf8');
    const match = toml.match(/^\s*GUEST_HOSTNAME\s*=\s*"([^"]+)"/m);
    return match ? match[1] : '';
  } catch {
    // Fail closed: no hostname means isGuestHostname() is always false.
    return '';
  }
}

const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_GUEST_HOSTNAME:
      process.env.NEXT_PUBLIC_GUEST_HOSTNAME ?? guestHostnameFromWranglerConfig(),
  },
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
        '@teacher-playground/excalidraw$': path.resolve(__dirname, 'node_modules/@teacher-playground/excalidraw/dist/prod/index.js'),
        '@teacher-playground/excalidraw/index.css$': path.resolve(__dirname, 'node_modules/@teacher-playground/excalidraw/dist/prod/index.css'),
      },
      aliasFields: ['browser'],
    };

    return config;
  },
};

module.exports = nextConfig;
