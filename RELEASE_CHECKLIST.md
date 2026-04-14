# Release Checklist

Use this before pushing a public GitHub repo or publishing to npm.

## Repository hygiene

- Confirm there are no local absolute paths in tracked files.
- Confirm there are no personal emails, phone numbers, or private URLs.
- Confirm there are no `.env` files, private keys, API keys, tokens, passwords, or certificates.
- Confirm `node_modules/` is ignored and not staged.
- Confirm temporary test scripts and local experiment files are removed.

## Functional checks

- Start the relay:

```bash
npx browser-relay relay-start
```

- In another terminal, verify the CLI can reach the relay:

```bash
npx browser-relay status
```

- Reload the unpacked extension and verify:
  - relay toggle works
  - socket status is up
  - tab counts update
  - max-tab limit is enforced

- Run the regression checks:

```bash
npm run test:e2e
npm run test:multisite
```

## Publish checks

- Confirm `package.json` has the intended package name and version.
- Confirm the npm package name is publishable. Current planned package name: `browser-relay-cli`.
- Confirm `LICENSE`, `README.md`, and `CHANGELOG.md` are present.
- Confirm the package contains the files needed for npm users:
  - `bin/`
  - `extension/`
  - `lib/`
  - `server/`

- Run a packaging preview:

```bash
npm pack --dry-run
```

- Confirm the unpacked extension path works from the packaged CLI:

```bash
npx browser-relay extension-path
```

## Final secret scan

```bash
find . -iname '.env' -o -iname '.env.*'
rg -n -i 'api[_-]?key|secret|token|password|bearer|@gmail|@qq|/Users/'
```

## GitHub

- Initialize git if needed.
- Review `git status`.
- Commit with a release-oriented message.
- Push to the intended public GitHub repository.

## npm

- Log in with the intended npm account:

```bash
npm whoami
```

- Publish with the correct access level:

```bash
npm publish --access public
```
