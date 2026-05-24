# Development Workflow

## Project layout

- `src/background`: extension background logic and service layer.
- `src/content`: content script injected into Yandex Music pages.
- `src/popup`: popup UI shown from the extension icon.
- `public`: static assets copied into `build`.
- `build`: compiled extension output that can be loaded into Chrome.

## Local workflow

1. Install dependencies:

```bash
npm install
```

2. Run the full validation pipeline:

```bash
npm run check
```

3. Rebuild in development mode while editing:

```bash
npm run build:watch
```

4. Load the extension from the `build` directory:

- Open `chrome://extensions`
- Enable `Developer mode`
- Click `Load unpacked`
- Select the `build` folder

## Available scripts

- `npm run lint`: run ESLint via `gts`
- `npm run typecheck`: run TypeScript checks without emitting files
- `npm run build`: production webpack build into `build`
- `npm run build:dev`: one-off development build
- `npm run build:watch`: watch mode for local development
- `npm run fix`: auto-fix lint and formatting issues
- `npm run check`: lint + typecheck + production build
- `npm run ci`: alias for `npm run check`

## CI

GitHub Actions workflow: `.github/workflows/ci.yml`

It runs:

- `npm ci`
- `npm run ci`
- artifact upload for the compiled `build` directory
