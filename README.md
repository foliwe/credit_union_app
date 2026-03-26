# Mobile App

This Expo app supports field agents and members with offline-first local storage and a Supabase-backed auth flow.

## Local setup

1. Install dependencies.

   ```bash
   npm install
   ```

2. Create a local env file from the tracked example.

   ```bash
   copy .env.example .env.local
   ```

3. Set the required Expo public variables in `.env.local`.

   ```dotenv
   EXPO_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
   EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   ```

4. Start Expo.

   ```bash
   npx expo start
   ```

5. After changing `.env.local`, do a full Expo restart before testing again.

## Expo Go preview behavior

- If `EXPO_PUBLIC_SUPABASE_URL` or `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is missing, the app now stays up and shows a configuration message on the login screen.
- Cached offline access still works only when the device already has a valid stored session.
- Live sign-in and other server-backed actions stay blocked until the public Supabase env is configured again.

## Notes

- Keep real local values in `.env.local` only. The repo tracks `.env.example` as the template.
- `EXPO_PUBLIC_*` values are bundled into the app, so do not treat them as secrets.
- `.env.local` remains ignored by Git through the existing `.env*.local` rule.
