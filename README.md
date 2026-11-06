# Green Fork Rewards

A React Native loyalty-program prototype built with Expo and TypeScript.

- **Events:** browse upcoming sample events, RSVP, and cancel an RSVP.
- **Menu:** browse sample food and drink prices and filter by category.
- **Rewards:** view a 120-point demo balance and confirm eligible redemptions.
  Redeeming deducts points; unavailable and already-redeemed rewards are disabled.

## Run

```sh
npm ci
npm start
```

Open the app using a compatible Expo Go installation, or use `npm run android`
or `npm run ios` with a configured emulator/simulator (iOS requires macOS).
For the browser preview, run `npm run web`.

## Validate

```sh
npx tsc --noEmit
npx expo export --platform web
```

No automated test runner is configured. Manually check all three tabs, menu
filters, RSVP/cancellation, redemption confirmation/cancellation, and the
disabled rewards after spending points.

## Prototype scope

All content and membership data are samples. State is held in memory and resets
on reload; RSVPs do not create real reservations and redemptions do not issue
real vouchers. There is no backend, sign-in, checkout, or purchase verification.
A production program would need these before awarding or redeeming real points.

The package overrides pin patched `glob` and `minimatch` versions to avoid
known denial-of-service advisories in Expo's transitive tooling dependencies.