# Contributing to ZipLink

Thanks for your interest in improving ZipLink. This project aims to stay small, readable and easy to run, so the guidelines below keep changes focused.

## Getting started

1. Fork the repository and clone your fork.
2. Install dependencies and create a local configuration:

   ```bash
   npm install
   npm run setup
   ```

3. Start the development server, which restarts when files change:

   ```bash
   npm run dev
   ```

4. Open <http://localhost:3000>.

## Project principles

- **No database.** Data stays in JSON files inside `data/`.
- **Few dependencies.** Add a package only when it clearly earns its place, and explain why in the pull request.
- **No front-end build step.** The interface is plain HTML, CSS and JavaScript in `public/`.
- **Real functionality only.** Every button must work, and analytics must come from real recorded activity. Do not add placeholder data.
- **Secure by default.** Validate input on the server, never render user content with `innerHTML`, and never commit secrets.
- **Clean code over comments.** Use clear names and small functions. Add a comment only when the reason for something is not obvious.
- **Keep the design restrained.** Dark theme, purple and cyan accents, readable typography, no decorative animation.

## Reporting bugs

Open an issue and include:

- What you expected and what happened instead
- Steps to reproduce
- Node.js version, operating system and browser
- Relevant server output, with any secrets removed

Do not report security vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead.

## Suggesting features

Open an issue describing the problem you want to solve before writing code. Features that need a database, accounts for other users, or heavy dependencies are unlikely to fit the project.

## Pull requests

1. Create a branch from `main`, for example `fix/alias-validation`.
2. Keep each pull request to a single change.
3. Test the change by hand: run the server, exercise the feature in the browser, and check it at phone width.
4. Update `README.md` and `CHANGELOG.md` when behavior or configuration changes.
5. Write clear commit messages in the imperative mood, such as "Reject aliases that start with a hyphen".
6. Describe what changed and why in the pull request, with screenshots for interface changes.

## Code style

- Two-space indentation, single quotes, semicolons.
- Use `const` by default, and avoid unused variables and dead code.
- Server responses use JSON with an `error` message for failures, and a `field` name when one input is at fault.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
