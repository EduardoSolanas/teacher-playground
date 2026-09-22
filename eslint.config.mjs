import coreWebVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...coreWebVitals,
  {
    // .claude/worktrees holds throwaway agent worktrees, each with its own
    // built .next/ and out/. Linting those bundles reported 51 react/display-name
    // errors against generated code and failed `npm run lint` for everyone.
    ignores: [
      "**/tailwind.config.js",
      ".wrangler/**",
      "excalidraw/**",
      ".claude/worktrees/**",
      "coverage/**",
      "coverage-e2e/**",
      // PDF.js runtime data copied in at build by scripts/copy-pdfjs-assets.mjs.
      "public/pdfjs/**",
    ],
  },
  {
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
];

export default config;
