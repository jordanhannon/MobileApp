# Green Fork Rewards

A React Native loyalty-program app built with Expo and TypeScript, backed by a
TypeScript REST API and PostgreSQL.

## Run locally

Requirements: Node.js 26.13.1 LTS (pinned in `.node-version`), npm, and Docker
Desktop (or another PostgreSQL 16+ instance). For fnm in PowerShell, initialize
its shell integration once in `$PROFILE`:

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

Restart the terminal, then run `fnm install` and `fnm use` from the repository
root. Verify the selected runtime with `node --version`.

1. Start PostgreSQL from the repository root:

   ```sh
   docker compose -f server/compose.yaml up -d
   ```

2. Configure and start the API:

   ```sh
   Copy-Item server/.env.example server/.env
   npm ci --prefix server
   npm run migrate --prefix server
   npm run dev --prefix server
   ```

   The API listens on port 3000. In development, verification and password-reset
   codes are printed in the API console. Configure SMTP for delivery by email.

3. Configure the app's API URL by copying `.env.example` to `.env`. For a physical
   phone, replace `localhost` with the development computer's LAN IP address.
   The phone and computer must be on the same network.

4. Start the app:

   ```sh
   npm ci
   npm start
   ```

   Open the app with Expo Go, or run `npm run android`, `npm run ios` (requires
   macOS), or `npm run web`.

To stop the local database, run
`docker compose -f server/compose.yaml down`. Its data remains in a named Docker
volume.

## Validate

```sh
npx tsc --noEmit
npx expo export --platform web
npm run typecheck --prefix server
npm test --prefix server
npm run test:postgres --prefix server
npm run build --prefix server
```

The backend unit tests use an in-memory store. To run the PostgreSQL integration
test, set `TEST_DATABASE_URL` to the local database connection string and run the
migration first with `npm run migrate --prefix server`.

## Architecture and production notes

- The app sends registration, sign-in, email verification, password reset,
  session, reward-list, and redemption requests to the API.
- PostgreSQL stores account records, Argon2id password hashes, hashed session
  tokens, email action-token hashes, redemptions, and the points ledger.
- Native refresh tokens are stored with Expo SecureStore. Web refresh tokens are
  sent in an HTTP-only cookie; serve the production app and API over HTTPS.
- Reward balances and redemption eligibility are calculated by the server.
  New accounts begin with zero points. Purchase and administrative point-credit
  workflows are not implemented yet.
- Staff and admin access is assigned to existing accounts only. Members can
  RSVP separately to each one-time or recurring event occurrence. Admins can
  create weekly and monthly series with an optional end date; event times use
  America/New_York and follow daylight-saving changes. Staff can search
  accounts, view attendee names and RSVP times,
  and review points reports. Admins can also manage events and rewards and
  assign roles. Point adjustment and account suspension are not available.
- To provision the first admin, connect to PostgreSQL with an authorized
  database administrator and promote a verified account:

  ```sql
  UPDATE users
  SET role = 'admin'
  WHERE email = lower('admin@example.com')
    AND email_verified_at IS NOT NULL
  RETURNING id, email, role;
  ```

  Confirm that exactly one intended account was updated, then provision at
  least one additional admin to avoid lockout. Do not expose role assignment
  through public registration. Subsequent role changes and other admin writes
  are recorded in `admin_audit_log`.
- Local prototype accounts are not migrated; users register through the API.
- Development Compose credentials and the development token-hash secret are for
  local use only. Production must use managed PostgreSQL, HTTPS, a strong
  randomly generated `TOKEN_HASH_SECRET`, configured SMTP credentials, and
  deployment-specific `API_ORIGINS` and `EXPO_PUBLIC_API_URL`. Do not expose
  development codes or secrets in production logs.

See [server/.env.example](./server/.env.example) for API configuration and
[.env.example](./.env.example) for the app API URL.
