# Contributing

**English** · [Deutsch](CONTRIBUTING.de.md)

SIPFunk is a small project by a single developer. Bug reports and improvements are welcome; there is no promise as to when something will be dealt with.

## Reporting bugs

- Describe what you did, what you expected and what happened.
- State the operating system, Node version, model and FRITZ!OS version of the box, and the AI provider and voice model used.
- Attach the relevant log lines **after cleaning them**: no phone numbers, names, e-mail addresses, credentials or call content. The same goes for screenshots and call logs.
- Do not report security vulnerabilities publicly, see [SECURITY.md](SECURITY.md).

## Submitting changes

- Both commands have to pass before you submit:

  ```bash
  npm run typecheck
  ```

  ```bash
  npm test
  ```

- If you change instructions to the AI (`src/ai/personas.ts`, `src/ai/scam.ts`, `src/ai/plan.ts`), run the simulator afterwards (`npm run sim`, needs an API key) and read the reports.
- Small, self-contained changes with a commit message that says what changes for the user. UI, AI instructions, code comments and commit messages are German; the documentation is set up for several languages: English without a suffix (`user-guide.md`), every translation with its language code before the extension (`user-guide.de.md`, `.env.example.de`). If you change a document, change all versions; a new language is added as another set of files with its code and linked in the table in the README.
- No new dependencies without a good reason. SIP, RTP and G.711 are deliberately implemented in-house and kept lean.
- Examples in code, tests and documentation use made-up names and reserved example values (`example.com`, `192.0.2.x`, phone numbers from the ranges the Bundesnetzagentur reserves for film and television), never real ones.
- What can only be checked on the phone is listed in [doc/test-checklist.md](doc/test-checklist.md). Say what you checked on a real line and what you did not.

## Tests and releases on GitHub

- Every push to `main` and every pull request runs the type check and the tests (`.github/workflows/ci.yml`).
- Pushing a tag `v1.2.3` builds the Windows installer and the portable ZIP and publishes them as a GitHub release (`.github/workflows/release.yml`). The version comes from the tag. The release text lists the changes: written by GitHub Copilot from the commit subjects since the previous tag if the repository secret `COPILOT_GITHUB_TOKEN` is set, otherwise the section of this version from `CHANGELOG.md`, and without such a section GitHub's generated notes; the plain commit list is always attached.
- The images in `doc/images/` come from `npm run screenshots`: it starts a demo instance with made-up data in a temporary folder (nothing from your own setup, no network access) and captures the web UI in German and English. Rerun it after visible UI changes and look at the images before committing.
- Version numbers: since 1.0.0 every new version increases the last digit (1.0.1, 1.0.2, …). The tag is `v<version>`, e.g. `v1.0.1`, annotated and set on the commit on `main` that carries this version.
- Before tagging: set the version in `package.json` and `package-lock.json` (`npm version 1.0.1 --no-git-tag-version`), move the entries under "Unreleased" in both changelogs to the new version with its date and leave the "Unreleased" heading in place, empty, for what comes next.

## What will not be accepted

Changes that weaken the dial target protection, enable several simultaneous calls or serial calling, bypass the confirmation required for the spam defence, or open the web UI to a network without a login. The reasons are in the [guidelines](doc/guidelines.md).

## License of contributions

SIPFunk is licensed under the GNU Affero General Public License, version 3 or later ([LICENSE](LICENSE)). By submitting a change you state that you are entitled to contribute it under that license and that you do so.
